/**
 * Gathering: trees, ore, vein-following, branch mining, drop pickup.
 *
 * Two rules run through all of it:
 *   1. Never break a block with lava behind it (checked per block, every block).
 *   2. Follow the whole vein, not one block — a human who mines one diamond and
 *      walks away is leaving the other seven behind.
 */
import { Vec3 } from 'vec3';
import { log } from '../util/log.js';
import { mem } from '../world/memory.js';
import { AbortError } from '../task.js';
import { isSafeToDig, groundBelow } from '../world/scan.js';
import { equipTool, toolNearlyBroken, bestPickaxe } from '../reflex/gear.js';
import { goTo, stopMoving } from './move.js';

const LOG_TYPES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log'];
const TORCH_EVERY = 7;

/** Materials that are always beneath her, never worth travelling to find. */
const UNDERGROUND = ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'dirt', 'gravel', 'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore'];

/** Ore names come in stone and deepslate flavours; "iron" should mean both. */
export function expandBlockNames(bot, name) {
  const mcData = bot.mcData;
  const raw = String(name).toLowerCase().replace(/\s+/g, '_');
  const out = new Set();
  const add = (n) => {
    if (mcData.blocksByName[n]) out.add(n);
  };

  add(raw);
  if (/^(iron|gold|coal|copper|diamond|emerald|lapis|redstone)$/.test(raw)) {
    add(`${raw}_ore`);
    add(`deepslate_${raw}_ore`);
  }
  if (raw.endsWith('_ore')) {
    add(`deepslate_${raw}`);
    add(raw.replace(/^deepslate_/, ''));
  }
  if (raw === 'wood' || raw === 'log' || raw === 'tree' || raw === 'logs') LOG_TYPES.forEach(add);
  if (raw === 'stone') {
    ['stone', 'deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'cobblestone', 'cobbled_deepslate'].forEach(add);
  }
  if (raw === 'dirt') ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol'].forEach(add);
  if (raw === 'sand') ['sand', 'red_sand'].forEach(add);
  if (raw === 'ancient_debris') add('ancient_debris');
  if (!out.size) {
    // Fuzzy last resort so "iron ore" style typos still work.
    for (const b of Object.keys(mcData.blocksByName)) {
      if (b.includes(raw)) out.add(b);
      if (out.size > 6) break;
    }
  }
  return [...out];
}

const idsFor = (bot, names) => names.map((n) => bot.mcData.blocksByName[n]?.id).filter((x) => x != null);

export function inventoryFull(bot) {
  const slots = bot.inventory.slots.slice(9, 45);
  const used = slots.filter(Boolean).length;
  return used / 36;
}

/**
 * Blocks that would not break. A dig can fail repeatedly for reasons she cannot see
 * — out of reach by a hair, protected region, claim plugin — and without a memory of
 * that she picks the same block again immediately and locks up on it.
 */
const digBlacklist = new Map();
const blacklistKey = (p) => `${p.x},${p.y},${p.z}`;

export function isBlacklisted(pos) {
  const until = digBlacklist.get(blacklistKey(pos));
  if (!until) return false;
  if (Date.now() > until) {
    digBlacklist.delete(blacklistKey(pos));
    return false;
  }
  return true;
}

function blacklist(pos, ms = 120000) {
  digBlacklist.set(blacklistKey(pos), Date.now() + ms);
}

/**
 * Dig one block properly: right tool, safety check, then pick up what drops.
 *
 * The timeout is the important part. bot.dig() can hang indefinitely — the server
 * never confirms the break, and the promise simply never settles. Observed live as
 * her standing frozen at one coordinate for over three minutes in the digging
 * posture, mining nothing, with nothing at all in the log. A dig that overruns three
 * times its expected duration is not going to finish.
 */
export async function digBlock(bot, task, block, { safety = true } = {}) {
  task.check();
  if (!block) return false;
  if (isBlacklisted(block.position)) return false;
  if (safety && !isSafeToDig(bot, block)) {
    log.reflex(`refusing to dig ${block.name} at ${block.position} — fluid behind it`);
    blacklist(block.position, 60000);
    return false;
  }
  if (!bot.canDigBlock(block)) {
    blacklist(block.position, 60000);
    return false;
  }

  await equipTool(bot, block);

  let expected = 3000;
  try {
    expected = bot.digTime(block) || 3000;
  } catch {}
  const limit = Math.min(20000, Math.max(4000, expected * 3 + 1500));

  let timer;
  try {
    await Promise.race([
      bot.dig(block),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`dig timed out after ${limit}ms`)), limit);
      }),
    ]);
    mem.bump('blocksMined');
    return true;
  } catch (err) {
    if (task.aborted) throw new AbortError();
    try {
      bot.stopDigging();
    } catch {}
    if (/timed out/.test(err.message)) {
      log.warn(`dig stalled on ${block.name} at ${block.position} — skipping it`);
      blacklist(block.position, 180000);
    } else {
      log.debug(`dig failed: ${err.message}`);
      blacklist(block.position, 30000);
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Flood-fill the whole ore body. This is what separates real miners from bots. */
export async function mineVein(bot, task, startBlock, { max = 24 } = {}) {
  const targetNames = new Set([startBlock.name]);
  // Treat stone and deepslate variants of the same ore as one vein.
  const base = startBlock.name.replace(/^deepslate_/, '');
  targetNames.add(base);
  targetNames.add(`deepslate_${base}`);

  const queue = [startBlock.position];
  const seen = new Set();
  let mined = 0;

  while (queue.length && mined < max) {
    task.check();
    const pos = queue.shift();
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const block = bot.blockAt(pos);
    if (!block || !targetNames.has(block.name)) continue;

    if (bot.entity.position.distanceTo(pos) > 4.2) {
      const res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 20000 });
      if (!res.ok) continue;
    }
    if (await digBlock(bot, task, block)) {
      mined++;
      mem.rememberOre(block.name, pos);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            if (!dx && !dy && !dz) continue;
            queue.push(pos.offset(dx, dy, dz));
          }
    }
  }
  if (mined) await collectDrops(bot, task, { radius: 6, quiet: true });
  return mined;
}

/** mine{block,count} — find it, walk to it, take the whole vein. */
export async function mine(bot, task, { block, count = 1, maxDistance = 64, optional = false } = {}) {
  const names = expandBlockNames(bot, block);
  if (!names.length) return { ok: false, reason: `never heard of "${block}"` };
  const ids = idsFor(bot, names);
  let got = 0;
  let misses = 0;

  /**
   * Hard stall detection, inside the loop.
   *
   * Relying on the outer watchdog was not enough: a `mine` nested inside `base`
   * inherited the parent's five-minute budget, so she stood at one coordinate for
   * three minutes in the digging animation while nothing was logged and nothing gave
   * up. This loop now polices itself — it reports progress out loud, and if it cannot
   * break a single block in a reasonable window it stops and says why.
   */
  const startedAt = Date.now();
  let lastProgressAt = Date.now();
  let lastReportAt = Date.now();
  let explores = 0;
  const MAX_EXPLORES = 2;
  const STALL_MS = 35000;
  const HARD_LIMIT_MS = 150000;

  log.act(`mining ${count}x ${names[0]}`);

  while (got < count && misses < 6) {
    const now = Date.now();
    if (now - lastProgressAt > STALL_MS) {
      return { ok: got > 0, detail: `mined ${got}x ${names[0]} then stalled`, got, reason: `could not break any ${names[0]} for ${Math.round(STALL_MS / 1000)}s` };
    }
    if (now - startedAt > HARD_LIMIT_MS) {
      return { ok: got > 0, detail: `mined ${got}x ${names[0]} (time limit)`, got };
    }
    if (now - lastReportAt > 15000) {
      lastReportAt = now;
      log.act(`still mining: ${got}/${count} ${names[0]}`);
    }
    task.check();
    if (toolNearlyBroken(bot)) {
      const spare = bestPickaxe(bot);
      if (!spare || toolNearlyBroken(bot, spare)) return { ok: got > 0, detail: `got ${got}, tool about to break`, got };
    }
    if (inventoryFull(bot) > 0.95) return { ok: true, detail: `got ${got}, inventory full`, got };

    const positions = bot.findBlocks({ matching: ids, maxDistance, count: 12 }).filter((p) => !isBlacklisted(p));
    if (!positions.length) {
      misses++;
      if (optional) return { ok: true, detail: `no ${names[0]} nearby`, got };

      /**
       * DO NOT GO SIGHTSEEING FOR STONE.
       *
       * Stone, dirt and deepslate are under her feet everywhere on the map, so
       * "search elsewhere" is the wrong answer — she was walking to the ocean and
       * back looking for cobblestone. Six consecutive explore calls were logged in one
       * session. If it is an underground material, go DOWN.
       */
      if (UNDERGROUND.some((u) => names.includes(u))) {
        log.act(`no ${names[0]} in reach — digging down for it instead of wandering`);
        const targetY = Math.max(-58, Math.round(bot.entity.position.y) - 6);
        await digDown(bot, task, { toY: targetY, staircase: true }).catch((e) => {
          if (e?.aborted) throw e;
        });
        continue;
      }

      // For genuinely surface-scattered resources, allow a couple of looks and no more.
      if (explores >= MAX_EXPLORES) {
        return { ok: got > 0, detail: `mined ${got}x ${names[0]}`, got, reason: `cannot find ${names[0]} anywhere near here` };
      }
      explores++;
      const { explore } = await import('./move.js');
      await explore(bot, task, { radius: 32 }).catch(() => {});
      continue;
    }

    let progressed = false;
    for (const pos of positions) {
      task.check();
      if (got >= count) break;
      const target = bot.blockAt(pos);
      if (!target || !names.includes(target.name)) continue;

      if (bot.entity.position.distanceTo(pos) > 4.2) {
        const res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 30000 });
        if (!res.ok) continue;
      }
      const veined = await mineVein(bot, task, bot.blockAt(pos) || target, { max: count - got + 4 });
      if (veined > 0) {
        got += veined;
        progressed = true;
        lastProgressAt = Date.now();
      }
    }
    if (!progressed) misses++;
  }

  await collectDrops(bot, task, { radius: 8, quiet: true });
  return { ok: got > 0 || optional, detail: `mined ${got}x ${names[0]}`, got };
}

/** Chop whole trees, trunk and all, and replant if she has saplings. */
export async function chopWood(bot, task, { count = 8 } = {}) {
  const ids = idsFor(bot, LOG_TYPES);
  let got = 0;
  let misses = 0;
  log.act(`chopping ${count} logs`);

  while (got < count && misses < 5) {
    task.check();
    const positions = bot.findBlocks({ matching: ids, maxDistance: 96, count: 8 });
    if (!positions.length) {
      misses++;
      const { explore } = await import('./move.js');
      await explore(bot, task, { radius: 48 }).catch(() => {});
      continue;
    }

    for (const pos of positions) {
      task.check();
      if (got >= count) break;
      const res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 30000 });
      if (!res.ok) {
        misses++;
        continue;
      }
      // Walk up the trunk.
      for (let dy = 0; dy < 14; dy++) {
        task.check();
        const b = bot.blockAt(pos.offset(0, dy, 0));
        if (!b || !LOG_TYPES.includes(b.name)) break;
        if (bot.entity.position.distanceTo(b.position) > 4.2) {
          const near = await goTo(bot, task, b.position.x, b.position.y, b.position.z, { range: 2, timeoutMs: 15000 });
          if (!near.ok) break;
        }
        if (await digBlock(bot, task, b)) got++;
        if (got >= count + 2) break;
      }
    }
    await collectDrops(bot, task, { radius: 10, quiet: true });
  }

  await plantSapling(bot, task).catch(() => {});
  return { ok: got > 0, detail: `chopped ${got} logs`, got };
}

async function plantSapling(bot, task) {
  const sapling = bot.inventory.items().find((i) => /sapling/.test(i.name));
  if (!sapling) return false;
  const dirt = bot.findBlock({
    matching: (b) => b && /grass_block|dirt|podzol/.test(b.name) && bot.blockAt(b.position.offset(0, 1, 0))?.boundingBox === 'empty',
    maxDistance: 6,
  });
  if (!dirt) return false;
  try {
    await bot.equip(sapling, 'hand');
    await bot.placeBlock(dirt, new Vec3(0, 1, 0));
    return true;
  } catch {
    return false;
  }
}

/** Walk over nearby dropped items so nothing is left behind. */
export async function collectDrops(bot, task, { radius = 12, quiet = false } = {}) {
  // Note: entity.objectType is deprecated in prismarine-entity and spams stack
  // traces on access. Match on name only.
  const drops = Object.values(bot.entities).filter(
    (e) => e && (e.name === 'item' || e.name === 'item_stack' || e.name === 'Item') && e.position && bot.entity.position.distanceTo(e.position) <= radius,
  );
  if (!drops.length) return { ok: true, detail: 'nothing to pick up' };
  if (!quiet) log.act(`collecting ${drops.length} drops`);

  let picked = 0;
  for (const d of drops.slice(0, 24)) {
    task.check();
    if (!bot.entities[d.id]) continue;
    const res = await goTo(bot, task, d.position.x, d.position.y, d.position.z, { range: 0, timeoutMs: 8000 });
    if (res.ok) picked++;
  }
  return { ok: true, detail: `picked up ${picked}`, got: picked };
}

/**
 * Staircase down to a target Y. Never a straight-down shaft — a straight shaft is
 * how you land in lava you cannot see.
 */
export async function digDown(bot, task, { toY = 16, staircase = true } = {}) {
  log.act(`descending to Y=${toY}`);
  let guard = 0;
  const yaw = bot.entity.yaw;
  let dir = new Vec3(-Math.round(Math.sin(yaw)), 0, -Math.round(Math.cos(yaw)));
  if (dir.x === 0 && dir.z === 0) dir = new Vec3(1, 0, 0);

  while (bot.entity.position.y > toY + 0.5 && guard++ < 500) {
    task.check();
    const p = bot.entity.position.floored();

    if (!staircase) {
      const below = bot.blockAt(p.offset(0, -1, 0));
      if (below && !(await digBlock(bot, task, below))) return { ok: false, reason: 'blocked or unsafe below' };
      await task.sleep(120);
      continue;
    }

    // One step of staircase: clear head, body, and the step down.
    const step = p.plus(dir).offset(0, -1, 0);
    const targets = [p.plus(dir).offset(0, 1, 0), p.plus(dir), step];

    let blocked = false;
    for (const t of targets) {
      const b = bot.blockAt(t);
      if (!b || b.boundingBox === 'empty') continue;
      if (/lava/.test(b.name)) {
        blocked = true;
        break;
      }
      if (!(await digBlock(bot, task, b))) {
        blocked = true;
        break;
      }
    }

    if (blocked) {
      // Turn 90 degrees and keep going rather than forcing it.
      dir = new Vec3(-dir.z, 0, dir.x);
      log.reflex('lava or bedrock ahead, turning');
      await task.sleep(200);
      continue;
    }

    const res = await goTo(bot, task, step.x, step.y, step.z, { range: 0, timeoutMs: 10000 });
    if (!res.ok) {
      bot.setControlState('forward', true);
      await task.sleep(400);
      bot.setControlState('forward', false);
    }

    if (guard % TORCH_EVERY === 0) await placeTorch(bot, task).catch(() => {});
  }
  stopMoving(bot);
  return { ok: true, detail: `at Y=${Math.round(bot.entity.position.y)}` };
}

export async function placeTorch(bot, task) {
  const torch = bot.inventory.items().find((i) => i.name === 'torch');
  if (!torch) return false;
  const p = bot.entity.position.floored();
  const floor = bot.blockAt(p.offset(0, -1, 0));
  if (!floor || floor.boundingBox !== 'block') return false;
  if (bot.blockAt(p)?.name === 'torch') return false;
  try {
    const prev = bot.heldItem;
    await bot.equip(torch, 'hand');
    await bot.placeBlock(floor, new Vec3(0, 1, 0));
    if (prev && prev.name !== 'torch') await bot.equip(prev, 'hand').catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/**
 * Branch mining. Descend to the ore's best Y, then tunnel, scanning constantly and
 * detouring onto anything valuable. Torches as she goes so nothing spawns behind her.
 */
export async function branchMine(bot, task, { targetY = 16, ore = 'iron_ore', count = 24, lavaCaution = false, maxTunnel = 260 } = {}) {
  const names = expandBlockNames(bot, ore);
  const ids = idsFor(bot, names);
  const valuable = idsFor(bot, ['diamond_ore', 'deepslate_diamond_ore', 'ancient_debris', 'emerald_ore', 'deepslate_emerald_ore', 'gold_ore', 'deepslate_gold_ore', 'iron_ore', 'deepslate_iron_ore', 'redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore', 'coal_ore', 'deepslate_coal_ore', 'copper_ore', 'deepslate_copper_ore']);

  let got = 0;
  const startY = Math.round(bot.entity.position.y);

  if (Math.abs(startY - targetY) > 3) {
    const down = await digDown(bot, task, { toY: targetY, staircase: true });
    if (!down.ok) return down;
    mem.addWaypoint(`mine_y${targetY}`, bot.entity.position);
  }

  log.act(`branch mining for ${ore} at Y=${targetY}`);
  const yaw = bot.entity.yaw;
  let dir = new Vec3(-Math.round(Math.sin(yaw)), 0, -Math.round(Math.cos(yaw)));
  if (dir.x === 0 && dir.z === 0) dir = new Vec3(1, 0, 0);

  for (let step = 0; step < maxTunnel && got < count; step++) {
    task.check();

    if (inventoryFull(bot) > 0.9) return { ok: true, detail: `${got} ${ore}, inventory full`, got };
    if (toolNearlyBroken(bot)) {
      const spare = bestPickaxe(bot);
      if (!spare || toolNearlyBroken(bot, spare)) return { ok: got > 0, detail: `${got} ${ore}, pickaxe dying`, got };
    }

    // Look around for anything worth a detour.
    const found = bot.findBlocks({ matching: valuable, maxDistance: 14, count: 8 });
    for (const pos of found) {
      task.check();
      const b = bot.blockAt(pos);
      if (!b) continue;
      if (lavaCaution && !isSafeToDig(bot, b)) continue;
      const wanted = names.includes(b.name);
      const mined = await mineVein(bot, task, b, { max: 16 });
      if (mined && wanted) got += mined;
      if (mined) log.act(`vein: ${mined}x ${b.name}`);
      if (got >= count) break;
    }
    if (got >= count) break;

    // Advance the 1x2 tunnel.
    const p = bot.entity.position.floored();
    const ahead = [p.plus(dir), p.plus(dir).offset(0, 1, 0)];
    let blocked = false;
    for (const t of ahead) {
      const b = bot.blockAt(t);
      if (!b || b.boundingBox === 'empty') continue;
      if (/lava/.test(b.name) || !isSafeToDig(bot, b)) {
        blocked = true;
        break;
      }
      if (!(await digBlock(bot, task, b))) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      dir = new Vec3(-dir.z, 0, dir.x);
      log.reflex('hazard ahead in tunnel, turning');
      continue;
    }

    const dest = p.plus(dir);
    const res = await goTo(bot, task, dest.x, dest.y, dest.z, { range: 0, timeoutMs: 8000 });
    if (!res.ok) {
      bot.setControlState('forward', true);
      await task.sleep(300);
      bot.setControlState('forward', false);
    }
    if (step % TORCH_EVERY === 0) await placeTorch(bot, task).catch(() => {});
  }

  await collectDrops(bot, task, { radius: 8, quiet: true });
  return { ok: got > 0, detail: `branch mined ${got}x ${ore}`, got };
}
