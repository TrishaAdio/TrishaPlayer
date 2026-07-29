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

/** Smithing table: 2 iron ingots and 4 planks. */
export async function ensureSmithingTable(bot, task) {
  const id = bot.mcData.blocksByName.smithing_table?.id;
  let block = id != null ? bot.findBlock({ matching: id, maxDistance: 24 }) : null;
  if (block) {
    if (bot.entity.position.distanceTo(block.position) > 3.2) {
      await goTo(bot, task, block.position.x, block.position.y, block.position.z, { range: 2 }).catch(() => {});
    }
    return block;
  }
  if (!item(bot, 'smithing_table')) {
    const made = await craft(bot, task, { item: 'smithing_table', count: 1 });
    if (!made.ok) return null;
  }
  const spot = bot.entity.position.floored().offset(1, 0, 0);
  if (await placeAt(bot, task, spot, 'smithing_table')) {
    mem.addWaypoint('smithing', spot);
    return bot.blockAt(spot);
  }
  return null;
}

/**
 * NETHERITE UPGRADE.
 *
 * Since 1.20 this needs three inputs: the upgrade template, the diamond item, and a
 * netherite ingot. The template is the hard part — it only generates in bastion
 * remnant loot — so this is written to work the moment one is obtained by any route
 * (bastion run, a trade, or handed over by RAREAURA) rather than assuming she can
 * always make one.
 *
 * Window layout for a smithing table: 0 = template, 1 = base item, 2 = addition,
 * 3 = result.
 */
export async function upgradeNetherite(bot, task, { item: itemName } = {}) {
  const template = item(bot, 'netherite_upgrade_smithing_template');
  if (!template) {
    return { ok: false, reason: 'no netherite_upgrade_smithing_template — bastion loot only' };
  }
  const ingot = item(bot, 'netherite_ingot');
  if (!ingot) return { ok: false, reason: 'no netherite ingot' };

  const wanted = itemName
    ? [String(itemName)]
    : ['diamond_sword', 'diamond_chestplate', 'diamond_helmet', 'diamond_leggings', 'diamond_boots', 'diamond_pickaxe', 'diamond_axe'];
  const base = wanted.map((n) => item(bot, n)).find(Boolean);
  if (!base) return { ok: false, reason: `no diamond item to upgrade (${wanted[0]})` };

  const table = await ensureSmithingTable(bot, task);
  if (!table) return { ok: false, reason: 'no smithing table' };

  let win; // reassigned when an extraction retry has to reopen the table
  try {
    win = await bot.openBlock(table);
  } catch (err) {
    return { ok: false, reason: `cannot open smithing table: ${err.message}` };
  }

  /**
   * Slot geometry, derived rather than assumed. prismarine-windows does not always
   * expose inventoryStart for a block window, and hardcoding 4 would break the
   * moment the layout changed — so fall back to counting from the end: the player
   * inventory is always the last 36 slots of any window.
   */
  const RESULT_SLOT = 3;
  /**
   * Do NOT trust window.inventoryStart here. For a smithing table prismarine-windows
   * reports 3, but slot 3 is the RESULT slot — so the "first empty inventory slot"
   * came back as 3 and every extraction attempt moved the result onto itself and
   * silently did nothing. The player inventory is always the final 36 slots, and it
   * can never start before slot 4 on this window.
   */
  const invStart = Math.max(RESULT_SLOT + 1, win.slots.length - 36);
  log.debug(`smithing window: type=${win.type} slots=${win.slots.length} reported=${win.inventoryStart} using=${invStart}`);

  const findIn = (name) => {
    for (let i = invStart; i < win.slots.length; i++) {
      if (win.slots[i]?.name === name) return i;
    }
    // Last resort: scan the whole window.
    for (let i = 0; i < win.slots.length; i++) {
      if (win.slots[i]?.name === name) return i;
    }
    return -1;
  };

  const firstEmpty = () => {
    for (let i = invStart; i < win.slots.length; i++) if (!win.slots[i]) return i;
    return -1;
  };

  try {
    const moves = [
      ['netherite_upgrade_smithing_template', 0],
      [base.name, 1],
      ['netherite_ingot', 2],
    ];
    for (const [name, dest] of moves) {
      const from = findIn(name);
      if (from === -1) throw new Error(`${name} vanished from the inventory`);
      await bot.moveSlotItem(from, dest);
      await wait(220);
    }

    await wait(600);
    const result = win.slots[3];
    if (!result) throw new Error('smithing produced no result — wrong combination');
    const upgraded = result.name;

    /**
     * Getting the result OUT, verified correctly.
     *
     * The earlier version checked bot.inventory while the smithing window was still
     * open — and bot.inventory mirrors the player window, not the block window, so a
     * successful move looked like a failure and the retries piled on top of each
     * other. The only reliable check is: close the window, then look.
     */
    /**
     * NEVER shift-click a smithing result.
     *
     * Verified against server-side `data get entity`: a shift-click does complete the
     * upgrade and the item really does reach the player's inventory, but mineflayer
     * loses track of it completely — `bot.inventory` reports empty, so she owns a
     * netherite sword she can never equip or see. An explicit move into a chosen slot
     * keeps the client model in sync and was confirmed correct on both sides.
     *
     * win.slots is raw and authoritative. bot.inventory is the derived view that goes
     * wrong while this window is open, so success is judged on the raw slot.
     */
    const rawTarget = firstEmpty();
    if (rawTarget === -1) {
      return { ok: false, reason: 'inventory full — no room for the upgraded item' };
    }

    await bot.moveSlotItem(RESULT_SLOT, rawTarget).catch((e) => log.debug(`move failed: ${e.message}`));
    await wait(700);

    const movedOk = win.slots[rawTarget]?.name === upgraded;
    if (!movedOk) {
      // One retry with a manual pickup-and-place, still avoiding shift-click.
      await bot.clickWindow(RESULT_SLOT, 0, 0).catch(() => {});
      await wait(300);
      await bot.clickWindow(rawTarget, 0, 0).catch(() => {});
      await wait(600);
    }

    const raw = win.slots[rawTarget]?.name;
    try {
      win.close();
    } catch {}
    await wait(900);

    const landed = bot.inventory.items().some((i) => i.name === upgraded);
    if (!landed && raw !== upgraded) {
      return { ok: false, reason: `smithed ${upgraded} but could not remove it from the table` };
    }

    log.act(`upgraded ${base.name} -> ${upgraded}`);
    mem.note(`netherite: ${upgraded}`);
    return { ok: true, detail: `upgraded to ${upgraded}` };
  } catch (err) {
    if (task.aborted) throw new AbortError();
    return { ok: false, reason: `smithing failed: ${err.message}` };
  } finally {
    try {
      win.close();
    } catch {}
  }
}

/**
 * Bastion remnants are the only source of the upgrade template.
 * Best effort by design: she looks for the distinctive blackstone brickwork while in
 * the nether, and loots any chest she can reach. Piglin brutes make this genuinely
 * dangerous, so it never becomes a required step.
 */
export async function raidBastion(bot, task, { searchRadius = 96 } = {}) {
  if (!inNether(bot)) return { ok: false, reason: 'not in the nether' };

  const marker = ['polished_blackstone_bricks', 'polished_blackstone_brick_stairs', 'chiseled_polished_blackstone', 'gilded_blackstone']
    .map((n) => bot.mcData.blocksByName[n]?.id)
    .filter((x) => x != null);

  const found = bot.findBlocks({ matching: marker, maxDistance: searchRadius, count: 4 });
  if (!found.length) return { ok: false, reason: 'no bastion structures in range' };

  log.act('bastion brickwork spotted — looking for chests');
  await goTo(bot, task, found[0].x, found[0].y, found[0].z, { range: 6, timeoutMs: 90000 }).catch(() => {});

  const chestIds = ['chest', 'trapped_chest'].map((n) => bot.mcData.blocksByName[n]?.id).filter((x) => x != null);
  const chests = bot.findBlocks({ matching: chestIds, maxDistance: 48, count: 6 });
  if (!chests.length) return { ok: false, reason: 'found the structure but no reachable chests' };

  let looted = 0;
  let gotTemplate = false;
  for (const pos of chests) {
    task.check();
    const res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 40000 });
    if (!res.ok) continue;
    const block = bot.blockAt(pos);
    if (!block) continue;
    try {
      const chest = await bot.openContainer(block);
      for (const it of chest.containerItems()) {
        await chest.withdraw(it.type, null, it.count).catch(() => {});
        if (it.name === 'netherite_upgrade_smithing_template') gotTemplate = true;
      }
      chest.close();
      looted++;
    } catch {}
  }
  return {
    ok: looted > 0,
    detail: `looted ${looted} bastion chest(s)${gotTemplate ? ' — GOT THE TEMPLATE' : ''}`,
    got: gotTemplate ? 1 : 0,
  };
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
