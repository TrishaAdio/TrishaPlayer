/**
 * THE NETHER — portal, ancient debris, netherite.
 *
 * Honest scope note, because this matters for what she can actually reach:
 * netherite *ingots* are fully attainable unattended (debris -> scrap -> ingot).
 * Netherite *gear* is not, because since 1.20 the upgrade also needs a
 * `netherite_upgrade_smithing_template`, and those only generate in bastion
 * remnant loot chests. Raiding a bastion with piglin brutes is a different class
 * of problem, so the ingot rungs are marked optional and she will not stall on
 * them. Enchanted diamond is her realistic ceiling, and it is very close to
 * netherite in practice.
 */
import { Vec3 } from 'vec3';
import { log } from '../util/log.js';
import { mem } from '../world/memory.js';
import { AbortError } from '../task.js';
import { goTo } from './move.js';
import { craft, smelt } from './craft.js';
import { mine, branchMine, collectDrops } from './gather.js';
import { placeAt } from './build.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (bot, n) => bot.inventory.items().reduce((a, i) => (i.name === n ? a + i.count : a), 0);
const item = (bot, n) => bot.inventory.items().find((i) => i.name === n);

export function dimensionOf(bot) {
  const d = String(bot.game?.dimension || '').replace('minecraft:', '');
  return d || 'overworld';
}

export const inNether = (bot) => dimensionOf(bot) === 'the_nether';

/** Flint from gravel plus an iron ingot. */
export async function makeFlintAndSteel(bot, task) {
  if (item(bot, 'flint_and_steel')) return { ok: true, detail: 'already has flint and steel' };

  if (count(bot, 'flint') < 1) {
    // Gravel drops flint about 10% of the time, so dig a lot of it.
    await mine(bot, task, { block: 'gravel', count: 24, optional: true }).catch((e) => {
      if (e?.aborted) throw e;
    });
    await collectDrops(bot, task, { radius: 10, quiet: true }).catch(() => {});
  }
  if (count(bot, 'flint') < 1) return { ok: false, reason: 'no flint yet — gravel is stingy' };
  if (count(bot, 'iron_ingot') < 1) {
    await smelt(bot, task, { item: 'iron_ingot', count: 1 }).catch(() => {});
  }
  const made = await craft(bot, task, { item: 'flint_and_steel', count: 1 });
  return made.ok ? { ok: true, detail: 'made flint and steel' } : { ok: false, reason: made.reason };
}

/**
 * Minimal 10-obsidian portal: 2 wide, 3 tall interior, no corners.
 * Built in the X/Y plane so she can stand back on Z and reach every block.
 */
export async function buildNetherPortal(bot, task) {
  if (count(bot, 'obsidian') < 10) {
    const { getObsidian } = await import('./enchant.js');
    const obs = await getObsidian(bot, task, { count: 10 });
    if (count(bot, 'obsidian') < 10) return { ok: false, reason: obs.reason || 'not enough obsidian for a portal' };
  }

  const fs = await makeFlintAndSteel(bot, task);
  if (!fs.ok) return { ok: false, reason: fs.reason };

  const base = bot.entity.position.floored().offset(2, 0, 0);
  const frame = [];
  // bottom and top
  for (const dx of [0, 1]) {
    frame.push(base.offset(dx, 0, 0));
    frame.push(base.offset(dx, 4, 0));
  }
  // sides
  for (let dy = 1; dy <= 3; dy++) {
    frame.push(base.offset(-1, dy, 0));
    frame.push(base.offset(2, dy, 0));
  }

  log.act(`building a nether portal at ${base.x},${base.y},${base.z}`);
  let placed = 0;
  for (const pos of frame) {
    task.check();
    // Clear the interior as we go so the portal has somewhere to form.
    if (await placeAt(bot, task, pos, 'obsidian')) placed++;
  }
  if (placed < 8) return { ok: false, reason: `only placed ${placed}/10 obsidian` };

  // Light it: flint and steel on the top face of a bottom frame block.
  try {
    await bot.equip(item(bot, 'flint_and_steel'), 'hand');
    const bottom = bot.blockAt(base);
    await bot.lookAt(base.offset(0.5, 1, 0.5), true);
    await bot.activateBlock(bottom);
    await wait(1200);
  } catch (err) {
    if (task.aborted) throw new AbortError();
    return { ok: false, reason: `could not light the portal: ${err.message}` };
  }

  const lit = bot.blockAt(base.offset(0, 1, 0))?.name === 'nether_portal';
  if (lit) {
    mem.addWaypoint('portal_overworld', base);
    mem.note(`nether portal at ${base.x},${base.y},${base.z}`);
  }
  return lit
    ? { ok: true, detail: 'portal lit' }
    : { ok: false, reason: 'frame built but the portal did not light' };
}

/** Step into the portal and wait for the dimension to actually change. */
export async function usePortal(bot, task, { timeoutMs = 30000 } = {}) {
  const from = dimensionOf(bot);
  const portal = bot.findBlock({ matching: (b) => b?.name === 'nether_portal', maxDistance: 24 });
  if (!portal) return { ok: false, reason: 'no portal nearby' };

  log.act(`entering portal from ${from}`);
  await goTo(bot, task, portal.position.x, portal.position.y, portal.position.z, { range: 0, timeoutMs: 20000 }).catch(() => {});

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    task.check();
    if (dimensionOf(bot) !== from) {
      await wait(2000); // let the chunks arrive
      const now = dimensionOf(bot);
      log.act(`arrived in ${now}`);
      mem.addWaypoint(now === 'the_nether' ? 'portal_nether' : 'portal_overworld', bot.entity.position);
      return { ok: true, detail: `now in ${now}` };
    }
    // Nudge into the portal blocks.
    bot.setControlState('forward', true);
    await wait(400);
    bot.setControlState('forward', false);
    await wait(400);
  }
  return { ok: false, reason: 'portal did not take her anywhere' };
}

/**
 * Ancient debris sits around Y=15 in the nether and is surrounded by lava, so the
 * dig-safety check matters more here than anywhere else in the game.
 */
export async function mineAncientDebris(bot, task, { count: want = 4 } = {}) {
  if (!inNether(bot)) return { ok: false, reason: 'not in the nether' };
  const pick = item(bot, 'diamond_pickaxe') || item(bot, 'netherite_pickaxe');
  if (!pick) return { ok: false, reason: 'ancient debris needs a diamond pickaxe' };

  return branchMine(bot, task, {
    targetY: 15,
    ore: 'ancient_debris',
    count: want,
    lavaCaution: true,
    maxTunnel: 220,
  });
}

/** Debris -> scrap -> ingot. 4 scrap + 4 gold per ingot. */
export async function makeNetheriteIngot(bot, task, { count: want = 1 } = {}) {
  const needScrap = want * 4;
  if (count(bot, 'netherite_scrap') < needScrap) {
    if (count(bot, 'ancient_debris') < needScrap - count(bot, 'netherite_scrap')) {
      return { ok: false, reason: `need ${needScrap} ancient debris, have ${count(bot, 'ancient_debris')}` };
    }
    await smelt(bot, task, { item: 'netherite_scrap', count: needScrap }).catch(() => {});
  }
  if (count(bot, 'gold_ingot') < want * 4) {
    await mine(bot, task, { block: 'gold_ore', count: want * 4, optional: true }).catch(() => {});
    await smelt(bot, task, { item: 'gold_ingot', count: want * 4 }).catch(() => {});
  }
  const made = await craft(bot, task, { item: 'netherite_ingot', count: want, optional: true });
  const have = count(bot, 'netherite_ingot');
  return { ok: have > 0, detail: `netherite ingots: ${have}`, got: have, reason: made.reason };
}

/**
 * The full trip, as one action: portal -> nether -> debris -> back home.
 * Every leg fails soft, because a nether run going wrong should not end the session.
 */
export async function netherRun(bot, task, { debris = 4 } = {}) {
  const steps = [];

  if (!inNether(bot)) {
    let portal = bot.findBlock({ matching: (b) => b?.name === 'nether_portal', maxDistance: 32 });
    if (!portal) {
      const built = await buildNetherPortal(bot, task);
      steps.push(`portal: ${built.ok ? 'lit' : built.reason}`);
      if (!built.ok) return { ok: false, reason: built.reason, detail: steps.join(' | ') };
    }
    const went = await usePortal(bot, task);
    steps.push(`travel: ${went.ok ? 'in the nether' : went.reason}`);
    if (!went.ok) return { ok: false, reason: went.reason, detail: steps.join(' | ') };
  }

  const dug = await mineAncientDebris(bot, task, { count: debris }).catch((e) => {
    if (e?.aborted) throw e;
    return { ok: false, reason: e.message };
  });
  steps.push(`debris: ${dug.detail || dug.reason}`);

  // Home again, even if the mining went badly.
  const back = await usePortal(bot, task).catch(() => ({ ok: false, reason: 'lost the portal' }));
  steps.push(`return: ${back.ok ? 'home' : back.reason}`);

  return { ok: (dug.got ?? 0) > 0, detail: steps.join(' | '), got: dug.got ?? 0 };
}
