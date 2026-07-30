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
import { config } from '../config.js';
import { mem } from '../world/memory.js';
import { AbortError } from '../task.js';
import { isSafeToDig, groundBelow } from '../world/scan.js';
import { equipTool, toolNearlyBroken, bestPickaxe, bestAxe } from '../reflex/gear.js';
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

const countItem = (bot, name) => bot.inventory.items().reduce((n, i) => (i.name === name ? n + i.count : n), 0);

/**
 * Keep a working pickaxe in her pack.
 *
 * A stone pickaxe lasts 131 blocks; a real branch-mining trip is several hundred. So
 * running dry underground is the normal case, not the exception — and the old code
 * simply abandoned the objective ("pickaxe dying"), which stranded the iron rung
 * permanently because the retry had no pickaxe either. She is standing in an unlimited
 * supply of cobblestone: the answer is to make another one where she stands.
 */
let lastPickaxeTry = 0;

export async function ensurePickaxe(bot, task) {
  const healthy = bot.inventory.items().filter((i) => /_pickaxe$/.test(i.name) && !toolNearlyBroken(bot, i));
  if (healthy.length) {
    // Make sure the healthy one is the one in her hand.
    if (toolNearlyBroken(bot)) await bot.equip(healthy[0], 'hand').catch(() => {});
    return true;
  }

  /**
   * Do not retry several times a second, and do not shout about it either. This was
   * called from every iteration of the mining loop and logged "making a fresh
   * stone_pickaxe on the spot" five times in eleven seconds while failing each time.
   */
  if (Date.now() - lastPickaxeTry < 15000) return false;
  lastPickaxeTry = Date.now();
  const tier = countItem(bot, 'cobblestone') >= 3 ? 'stone_pickaxe' : 'wooden_pickaxe';
  log.act(`[tools] pickaxe nearly spent — making a fresh ${tier} on the spot`);
  const { craft } = await import('./craft.js');
  const made = await craft(bot, task, { item: tier, count: 1, optional: true });
  if (made.ok) {
    const fresh = bot.inventory.items().find((i) => i.name === tier);
    if (fresh) await bot.equip(fresh, 'hand').catch(() => {});
    return true;
  }
  log.warn(`[tools] could not replace the pickaxe: ${made.reason || 'no materials'}`);
  return false;
}

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
export async function digBlock(bot, task, block, { safety = true, harvest = true } = {}) {
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

  /**
   * MINING LOCK.
   *
   * The weapon-ready reflex swaps a tool out for a sword whenever a mob is within 12
   * blocks. That is right in a fight and catastrophic while mining: it fired between
   * the tool being equipped and the dig starting, so the harvest check saw a sword in
   * hand and refused the block. Logged 73 times in one session — she could not mine a
   * single stone with a pickaxe in her pack.
   *
   * While a dig is in progress her hands belong to the pickaxe.
   */
  bot._miningNow = true;
  await equipTool(bot, block);

  /**
   * THE ONE THAT WASTED NINE MINUTES.
   *
   * Stone broken with a fist breaks fine — and drops absolutely nothing. So she would
   * "mine" successfully forever while her inventory never grew, which is exactly what
   * "mining but not mining" looked like from outside. If a block needs a tool she does
   * not have, digging it is pure loss: refuse, and say what is missing so the layer
   * above can go and craft one.
   */
  if (harvest !== false) {
    const need = bot.mcData.blocks[block.type]?.harvestTools;
    if (need && !need[bot.heldItem?.type]) {
      // Something took her tool out of her hand. Put it back before giving up.
      const proper = bot.inventory.items().find((i) => need[i.type]);
      if (proper) {
        await bot.equip(proper, 'hand').catch(() => {});
      }
      if (!need[bot.heldItem?.type]) {
        bot._miningNow = false;
        /**
         * DO NOT BLACKLIST THE BLOCK. Her tool is the problem, not the position.
         *
         * This cost an entire live run. Both her stone pickaxes wore out at Y=8, and from
         * then on every iron ore she walked up to was refused here AND blacklisted for
         * 20 seconds — so `branchMine` reported "0x iron_ore" after 490 seconds of
         * tunnelling through ore it had itself marked as unmineable. The ore was fine.
         *
         * A missing tool is a fact about her inventory and is recorded there, so the
         * caller can go and fix the real cause.
         */
        bot._needsToolFor = block.name;
        log.warn(`${block.name} needs a proper tool — a fist breaks it but drops nothing. skipping (not blacklisting).`);
        return false;
      }
    }
  }

  /**
   * Trust digTime, and give it room.
   *
   * bot.digTime() already accounts for the held tool AND the ~4.75x penalty for mining
   * while in water. The old cap of 20s ignored that: a fist on stone underwater is
   * legitimately ~35s, so every such dig was declared "stalled" and abandoned. Eleven
   * in a row on one live run, nine minutes, nothing gained.
   */
  let expected = 3000;
  try {
    expected = bot.digTime(block) || 3000;
  } catch {}
  const limit = Math.min(60000, Math.max(5000, expected * 2.5 + 2000));

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
    bot._miningNow = false;
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

  /**
   * Check she can actually harvest this before walking anywhere.
   *
   * Without this she would trek to a stone face with bare hands and mine for nine
   * minutes for zero items. Failing immediately with a clear reason lets the planner
   * or the ladder go and make a pickaxe, which is the actual next step.
   */
  const sample = bot.mcData.blocksByName[names[0]];
  if (sample?.harvestTools) {
    /**
     * A tool one hit from snapping is not a usable tool.
     *
     * She crafted three wooden pickaxes in eight minutes — 59 uses each — and each time
     * one broke mid-job the whole objective failed and the plan moved on, which is why
     * she never reached coal or iron. Reporting the need up front lets the repair step
     * craft a replacement (ideally a better one) before she walks anywhere.
     */
    const candidates = bot.inventory.items().filter((i) => sample.harvestTools[i.type]);
    const healthy = candidates.filter((i) => !toolNearlyBroken(bot, i));
    if (candidates.length && !healthy.length) {
      const best = candidates[0];
      const upgrade = best.name.startsWith('wooden_') ? best.name.replace('wooden_', 'stone_') : best.name;
      return {
        ok: false,
        reason: `${best.name} is about to break — needs a fresh ${upgrade} before mining ${names[0]}`,
        needsTool: upgrade,
      };
    }

    const usable = healthy.length > 0;
    if (!usable) {
      /**
       * Name the tool she actually needs, not just "a pickaxe".
       *
       * She had a wooden pickaxe and was told "cannot harvest iron_ore without a
       * pickaxe", which is both true and useless — iron needs STONE tier or better.
       * The layer above cannot fix a problem it has been described wrongly.
       */
      const accepted = Object.keys(sample.harvestTools)
        .map((id) => bot.mcData.items[Number(id)]?.name)
        .filter(Boolean);
      const tiers = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
      const cheapest = tiers.find((t) => accepted.some((a) => a.startsWith(t)));
      const kind = accepted[0]?.split('_').slice(1).join('_') || 'pickaxe';
      const needed = cheapest ? `${cheapest}_${kind}` : accepted[0] || 'a better tool';
      return {
        ok: false,
        reason: `${names[0]} needs at least a ${needed} — it drops nothing by hand`,
        needsTool: needed,
      };
    }
  }

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
      const p = bot.entity.position;
      log.act(
        `[mine] ${got}/${count} ${names[0]} | at ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} | hp ${Math.round(bot.health)} | food ${bot.food} | misses ${misses}`,
      );
    }
    task.check();
    if (toolNearlyBroken(bot) && !(await ensurePickaxe(bot, task))) {
      return { ok: got > 0, detail: `got ${got}, out of pickaxes`, got, needsTool: 'stone_pickaxe' };
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
        task.beat(`${got}/${count} ${names[0]} | vein of ${veined} at ${pos.x},${pos.y},${pos.z} | hp ${Math.round(bot.health)} | food ${bot.food}`);
      }
    }
    if (!progressed) misses++;
  }

  await collectDrops(bot, task, { radius: 8, quiet: true });
  return { ok: got > 0 || optional, detail: `mined ${got}x ${names[0]}`, got };
}

/**
 * Is this a log she can plausibly stand next to and cut?
 *
 * findBlocks will happily hand back canopy logs twenty blocks up a cliff and logs
 * buried inside a hillside. Preferring the bottom of a trunk keeps her cutting from the
 * ground, which is both reachable and drops the rest of the tree within pickup range.
 */
function isTrunkBase(bot, pos) {
  const below = bot.blockAt(pos.offset(0, -1, 0));
  if (!below) return false;
  if (LOG_TYPES.includes(below.name)) return false; // not the bottom of the trunk
  // A log sealed inside terrain cannot be reached, however close it looks.
  for (const off of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const n = bot.blockAt(pos.offset(off[0], off[1], off[2]));
    if (n && n.boundingBox === 'empty') return true;
  }
  return false;
}

/**
 * Fell one tree by flood-filling its connected log blocks.
 *
 * The old code walked straight up from the first log and stopped at the first gap, so
 * every branch and every leaning or 2x2 trunk was left standing. Trees are not columns.
 */
async function fellTree(bot, task, start, max = 12) {
  const queue = [start];
  const seen = new Set();
  let felled = 0;

  while (queue.length && felled < max) {
    task.check();
    const pos = queue.shift();
    const key = `${pos.x},${pos.y},${pos.z}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const b = bot.blockAt(pos);
    if (!b || !LOG_TYPES.includes(b.name)) continue;
    if (isBlacklisted(pos)) continue;

    if (bot.entity.position.distanceTo(pos) > 4.2) {
      const res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 12000 });
      if (!res.ok) continue;
    }
    if (await digBlock(bot, task, b)) {
      felled++;
      task.beat();
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            if (!dx && !dy && !dz) continue;
            queue.push(pos.offset(dx, dy, dz));
          }
    }
  }
  return felled;
}

/**
 * Chop trees and come back with LOGS IN HER PACK.
 *
 * THE REPORTED FAILURE. The old version incremented a counter every time `bot.dig`
 * resolved and returned "chopped 8 logs" whether or not a single log ever reached her
 * inventory. The wood rung counts inventory, so it stayed unsatisfied, the ladder asked
 * again, and she went off to break eight more blocks she would also never pick up —
 * which from outside is exactly "she cannot even collect wood reliably".
 *
 * Success is now defined by inventory gain, and nothing else.
 */
export async function chopWood(bot, task, { count = 8 } = {}) {
  const ids = idsFor(bot, LOG_TYPES);
  const owned = () => LOG_TYPES.reduce((n, name) => n + countItem(bot, name), 0);
  const startOwned = owned();
  const want = startOwned + Math.max(1, count);

  log.act(`chopping for ${count} logs (has ${startOwned})`);

  let misses = 0;
  let explores = 0;
  let broke = 0;
  let surfaced = 0;
  let radius = 48;
  const MAX_EXPLORES = 3;
  const HARD_LIMIT_MS = 240000;
  const startedAt = Date.now();
  const gained = () => owned() - startOwned;

  while (owned() < want && misses < 6) {
    task.check();
    if (Date.now() - startedAt > HARD_LIMIT_MS) {
      return { ok: gained() > 0, got: gained(), detail: `chopped ${gained()} logs (time limit)` };
    }

    const positions = bot
      .findBlocks({ matching: ids, maxDistance: radius, count: 24 })
      .filter((p) => !isBlacklisted(p) && isTrunkBase(bot, p));

    if (!positions.length) {
      /**
       * No trees grow underground. Searching sideways at Y=11 can never succeed, and a
       * live run burned five minutes and then a death proving it. Go up first.
       */
      if (bot.entity.position.y < 55 && surfaced < 2) {
        surfaced++;
        const { ascendToSurface } = await import('./move.js');
        log.act(`[chopWood] no trees at Y=${Math.round(bot.entity.position.y)} — surfacing before searching (${surfaced}/2)`);
        const up = await ascendToSurface(bot, task, { targetY: 63 }).catch(() => ({ ok: false }));
        if (!up.ok) {
          const { goHome } = await import('./move.js');
          await goHome(bot, task).catch(() => {});
        }
        continue;
      }

      misses++;
      if (explores >= MAX_EXPLORES) {
        return {
          ok: gained() > 0,
          got: gained(),
          detail: `chopped ${gained()} logs`,
          reason: `no reachable tree trunk within ${radius}m after ${explores} moves`,
        };
      }
      explores++;
      radius = Math.min(112, radius + 24);
      log.act(`[chopWood] no reachable trunk in range — moving to new ground (${explores}/${MAX_EXPLORES}), widening search to ${radius}m`);
      const { explore } = await import('./move.js');
      await explore(bot, task, { radius: 64 }).catch(() => {});
      continue;
    }

    let progressed = false;
    for (const pos of positions) {
      task.check();
      if (owned() >= want) break;

      const trunk = bot.blockAt(pos);
      if (!trunk || !LOG_TYPES.includes(trunk.name)) continue;
      const before = owned();
      const dist = bot.entity.position.distanceTo(pos);

      task.beat(
        `${gained()}/${count} logs | target ${trunk.name} at ${pos.x},${pos.y},${pos.z} | distance ${Math.round(dist)}m | hp ${Math.round(bot.health)} | food ${bot.food}`,
      );

      if (dist > 4.0) {
        /**
         * Two attempts, the second one loose.
         *
         * A spruce forest on a slope defeated the single strict attempt: trees 5-7m away
         * but a few blocks below her, 25 seconds was not enough for pathfinder to find a
         * safe way down, and she blacklisted every tree in the wood and then explored
         * away from a perfectly good forest. She does not need to stand at the foot of
         * the trunk — anywhere within reach of any of its logs will do.
         */
        let res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 40000 });
        if (!res.ok) res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 4, timeoutMs: 20000 });
        if (!res.ok) {
          log.debug(`[chopWood] cannot reach trunk at ${pos.x},${pos.y},${pos.z} (${res.reason}) — blacklisted 2m`);
          blacklist(pos, 120000);
          misses++;
          continue;
        }
      }

      const felled = await fellTree(bot, task, pos, want - owned() + 3);
      broke += felled;
      // The drops are the entire point of the exercise.
      await collectDrops(bot, task, { radius: 12, quiet: true });
      const got = owned() - before;
      if (got > 0) progressed = true;
      log.act(`[chopWood] felled ${felled} blocks at ${pos.x},${pos.y},${pos.z}, +${got} logs in pack (${gained()}/${count})`);
      // Broke blocks but gained nothing, or could not break any: stop returning here.
      if (felled === 0 || got === 0) blacklist(pos, 120000);
    }
    if (!progressed) misses++;
  }

  await plantSapling(bot, task).catch(() => {});
  const got = gained();
  return {
    ok: got > 0,
    got,
    detail: `chopped ${got} logs (${broke} blocks broken)`,
    reason: got === 0 ? 'broke logs but none reached the pack' : undefined,
  };
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

/**
 * Dropped item entities near her.
 *
 * Matched on name AND on the registry's numeric entity type. `entity.objectType` is
 * deprecated in prismarine-entity and spams stack traces on access, so it is never
 * touched; the numeric type is the stable way to ask the question across versions.
 */
function droppedItems(bot, radius) {
  const itemType = bot.registry?.entitiesByName?.item?.id ?? bot.mcData?.entitiesByName?.item?.id;
  const me = bot.entity.position;
  return Object.values(bot.entities).filter((e) => {
    if (!e || !e.position) return false;
    const isItem = e.name === 'item' || e.name === 'item_stack' || (itemType != null && e.entityType === itemType);
    return isItem && me.distanceTo(e.position) <= radius;
  });
}

/**
 * Walk over nearby dropped items so nothing is left behind.
 *
 * Two fixes over the old version. It aimed at the drop with GoalNear range 0, which is
 * an exact-block goal that frequently cannot be satisfied for an item resting on a slab
 * or a slope — so the walk "failed" while she was standing right next to the item. And
 * it reported how many goals it reached rather than what she actually picked up, so a
 * chop that collected nothing still looked like a success.
 */
export async function collectDrops(bot, task, { radius = 12, quiet = false } = {}) {
  const total = () => bot.inventory.items().reduce((n, i) => n + i.count, 0);
  const before = total();

  const drops = droppedItems(bot, radius);
  if (!drops.length) return { ok: true, detail: 'nothing to pick up', got: 0 };
  if (!quiet) log.act(`collecting ${drops.length} drops within ${radius}m`);

  // Nearest first, so the pickup magnet sweeps up clusters along the way.
  drops.sort((a, b) => bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));

  let visited = 0;
  for (const d of drops.slice(0, 24)) {
    task.check();
    if (!bot.entities[d.id]) continue; // the magnet already got it
    const p = d.position;
    const res = await goTo(bot, task, p.x, p.y, p.z, { range: 1, timeoutMs: 10000 });
    visited++;
    if (res.ok) {
      // Pickup is a server-side sweep of roughly 1.5 blocks; give it a moment to fire.
      await task.sleep(350);
      task.beat();
    }
  }

  const got = total() - before;
  if (!quiet) log.act(`picked up ${got} items from ${visited} drops`);
  return { ok: true, detail: `picked up ${got} items`, got };
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
/**
 * Is there a large open space just ahead?
 *
 * Caves are where the mobs are, and she mines iron with no armour on — a live run was
 * killed by a zombie underground and shot at by a skeleton she could not reach. An open
 * cavern is a hazard to be tunnelled around, not a shortcut to be walked into.
 */
function openSpaceAhead(bot, from, dir, reach = 4) {
  let air = 0;
  let checked = 0;
  for (let d = 1; d <= reach; d++) {
    for (let dy = 0; dy <= 2; dy++) {
      for (const side of [-1, 0, 1]) {
        const p = from.plus(dir.scaled(d)).offset(dir.z * side, dy, dir.x * side);
        const b = bot.blockAt(p);
        if (!b) continue;
        checked++;
        if (b.boundingBox === 'empty' && !/water|lava/.test(b.name)) air++;
      }
    }
  }
  return checked > 6 && air / checked > 0.62;
}

export async function branchMine(
  bot,
  task,
  { targetY = 16, ore = 'iron_ore', count = 24, lavaCaution = false, maxTunnel = 260, scanRadius = config.ladder.oreScan, avoidCaves = true } = {},
) {
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

  /**
   * FAIL FAST IF SHE CANNOT ACTUALLY HARVEST THE TARGET.
   *
   * Without this the trip runs its full course achieving nothing: a live run spent 490
   * seconds underground with no usable pickaxe and came back with zero ore. Twenty
   * seconds and a clear `needsTool` lets the layer above craft one on the surface, where
   * the wood is.
   */
  const sampleOre = bot.mcData.blocksByName[names[0]];
  if (sampleOre?.harvestTools) {
    const canHarvest = () => bot.inventory.items().some((i) => sampleOre.harvestTools[i.type] && !toolNearlyBroken(bot, i));
    if (!canHarvest() && !(await ensurePickaxe(bot, task))) {
      return {
        ok: false,
        got: 0,
        reason: `no usable pickaxe for ${names[0]} — cannot mine it by hand`,
        needsTool: 'stone_pickaxe',
      };
    }
  }

  log.act(`branch mining for ${ore} at Y=${targetY}`);
  let lastOreAt = Date.now();
  const BARREN_MS = 150000;
  const yaw = bot.entity.yaw;
  let dir = new Vec3(-Math.round(Math.sin(yaw)), 0, -Math.round(Math.cos(yaw)));
  if (dir.x === 0 && dir.z === 0) dir = new Vec3(1, 0, 0);

  for (let step = 0; step < maxTunnel && got < count; step++) {
    task.check();

    /**
     * GET OUT OF THE WATER.
     *
     * She drowned at Y=10 chasing a seam inside an aquifer. The reflex layer panicked
     * three times over 43 seconds and still lost her, because the mining loop kept
     * pulling her back down to the ore. Abandoning the seam is the correct move: the
     * trip can resume somewhere dry.
     */
    if (bot.entity?.isInWater) {
      log.reflex('underwater in the mine — abandoning this seam before it drowns her');
      const { ascendToSurface } = await import('./move.js');
      await ascendToSurface(bot, task, { targetY: 63, timeoutMs: 45000 }).catch(() => {});
      return { ok: got > 0, got, detail: `${got} ${ore}, hit water and pulled out`, reason: 'flooded seam — try elsewhere' };
    }

    if (inventoryFull(bot) > 0.9) return { ok: true, detail: `${got} ${ore}, inventory full`, got };
    if (toolNearlyBroken(bot) && !(await ensurePickaxe(bot, task))) {
      return { ok: got > 0, detail: `${got} ${ore}, out of pickaxes`, got, needsTool: 'stone_pickaxe' };
    }

    /**
     * Barren ground is a reason to change plan, not to keep digging.
     *
     * 490 seconds of tunnelling for nothing is not persistence, it is a loop. Report it
     * so the rung retries somewhere else instead of grinding the same dead seam.
     */
    if (got === 0 && Date.now() - lastOreAt > BARREN_MS) {
      return {
        ok: false,
        got: 0,
        detail: `no ${ore} found in ${Math.round(BARREN_MS / 1000)}s at Y=${Math.round(bot.entity.position.y)}`,
        reason: `no ${ore} anywhere in this seam — try a different area or depth`,
      };
    }

    /**
     * SCAN WIDE FOR THE ORE SHE CAME FOR, THEN WALK TO IT.
     *
     * Blind tunnelling is why an entire trip came back empty: she dug a straight line
     * for hundreds of blocks and simply never crossed a seam. The server already streams
     * every block of the loaded chunks to her, so searching a wide radius for the target
     * ore and walking to it is both far faster and far less dangerous than digging on
     * spec. Tunnelling is now only what she does when there is genuinely nothing in range.
     */
    const targets = bot
      .findBlocks({ matching: ids, maxDistance: scanRadius, count: 32 })
      .filter((pos) => !isBlacklisted(pos));

    if (targets.length) {
      log.debug(`[branchMine] ${targets.length} ${names[0]} in range ${scanRadius}m`);
      for (const pos of targets) {
        task.check();
        if (got >= count) break;
        const b = bot.blockAt(pos);
        if (!b || !names.includes(b.name)) continue;

        /**
         * ALWAYS check for fluid, not only when lavaCaution was asked for.
         *
         * The iron rung calls this without lavaCaution, so nothing stopped her walking
         * into an aquifer at Y=10 to reach a seam. The server log reads "Trisha drowned"
         * after 43 seconds of "panic: drowning". Wet iron is not worth dying for — there
         * is always another seam.
         */
        if (!isSafeToDig(bot, b)) {
          blacklist(pos, 120000);
          log.debug(`[branchMine] skipping ${b.name} at ${pos.x},${pos.y},${pos.z} — fluid against it`);
          continue;
        }

        if (bot.entity.position.distanceTo(pos) > 4.2) {
          const res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 25000 });
          if (!res.ok) {
            blacklist(pos, 90000);
            continue;
          }
        }
        const mined = await mineVein(bot, task, bot.blockAt(pos) || b, { max: 16 });
        if (mined) {
          got += mined;
          lastOreAt = Date.now();
          const p = bot.entity.position;
          task.beat(
            `${got}/${count} ${ore} | vein of ${mined} at ${pos.x},${pos.y},${pos.z} | at ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} | hp ${Math.round(bot.health)} | food ${bot.food}`,
            { everyMs: 10000 },
          );
        } else {
          blacklist(pos, 60000);
        }
        if (step % 3 === 0) await placeTorch(bot, task).catch(() => {});
      }
      continue; // keep working the scan rather than falling through to blind digging
    }

    // Nothing of the target in range — sweep up anything else useful close by (coal for
    // torches and furnace fuel especially) before committing to more tunnel.
    const found = bot.findBlocks({ matching: valuable, maxDistance: 16, count: 8 });
    for (const pos of found) {
      task.check();
      const b = bot.blockAt(pos);
      if (!b) continue;
      if (lavaCaution && !isSafeToDig(bot, b)) continue;
      const wanted = names.includes(b.name);
      const mined = await mineVein(bot, task, b, { max: 16 });
      if (mined && wanted) {
        got += mined;
        lastOreAt = Date.now();
      }
      if (mined) {
        const p = bot.entity.position;
        task.beat(
          `${got}/${count} ${ore} | vein of ${mined}x ${b.name} | at ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)} | hp ${Math.round(bot.health)} | food ${bot.food} | tunnel ${step}`,
          { everyMs: 10000 },
        );
        log.debug(`vein: ${mined}x ${b.name}`);
      }
      if (got >= count) break;
    }
    if (got >= count) break;

    // Advance the 1x2 tunnel.
    const p = bot.entity.position.floored();

    // Turn away from open caverns rather than breaking into them unarmoured.
    if (avoidCaves && openSpaceAhead(bot, p, dir)) {
      dir = new Vec3(-dir.z, 0, dir.x);
      log.reflex(`open cave ahead at ${p.x},${p.y},${p.z} — turning away from it`);
      await placeTorch(bot, task).catch(() => {});
      continue;
    }

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
    // Tunnelling forward IS progress even when no ore turns up, and the watchdog needs
    // to know that or it cancels a perfectly good mining trip every 3 minutes.
    task.beat(
      `${got}/${count} ${ore} | tunnelling at Y=${Math.round(bot.entity.position.y)} step ${step}/${maxTunnel} | hp ${Math.round(bot.health)} | food ${bot.food}`,
      { everyMs: 20000 },
    );
    if (step % TORCH_EVERY === 0) await placeTorch(bot, task).catch(() => {});
  }

  await collectDrops(bot, task, { radius: 8, quiet: true });
  return { ok: got > 0, detail: `branch mined ${got}x ${ore}`, got };
}
