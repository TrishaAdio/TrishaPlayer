/**
 * Crafting and smelting, with recursive dependency resolution — ask for a
 * diamond pickaxe and she works out that she needs sticks, which need planks,
 * which need logs, and goes and gets them.
 */
import { Vec3 } from 'vec3';
import { log } from '../util/log.js';
import { mem } from '../world/memory.js';
import { goTo } from './move.js';
import { AbortError } from '../task.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PLANK_FROM_LOG = {
  oak_log: 'oak_planks', birch_log: 'birch_planks', spruce_log: 'spruce_planks',
  jungle_log: 'jungle_planks', acacia_log: 'acacia_planks', dark_oak_log: 'dark_oak_planks',
  mangrove_log: 'mangrove_planks', cherry_log: 'cherry_planks', pale_oak_log: 'pale_oak_planks',
};

const SMELT_INPUT = {
  iron_ingot: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
  gold_ingot: ['raw_gold', 'gold_ore', 'deepslate_gold_ore', 'golden_sword', 'golden_pickaxe'],
  copper_ingot: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'],
  cooked_beef: ['beef'], cooked_porkchop: ['porkchop'], cooked_mutton: ['mutton'],
  cooked_chicken: ['chicken'], cooked_rabbit: ['rabbit'], cooked_cod: ['cod'], cooked_salmon: ['salmon'],
  baked_potato: ['potato'], dried_kelp: ['kelp'], glass: ['sand', 'red_sand'],
  charcoal: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'],
  stone: ['cobblestone'], smooth_stone: ['stone'], deepslate: ['cobbled_deepslate'], brick: ['clay_ball'],
  netherite_scrap: ['ancient_debris'], green_dye: ['cactus'], popped_chorus_fruit: ['chorus_fruit'],
};

const FUELS = ['coal', 'charcoal', 'coal_block', 'blaze_rod', 'dried_kelp_block', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'oak_log', 'birch_log', 'spruce_log', 'stick', 'bamboo'];

/**
 * How many items one unit of each fuel smelts.
 *
 * This matters more than it looks. The old code always loaded `ceil(batch / 8)` units,
 * which is only correct for coal — fuelling a 30-iron batch with 4 planks burns out
 * after 6 ingots and the smelt reports a partial result, which then un-does the iron
 * rung. Planks and logs are 1.5 items each, sticks half an item.
 */
const FUEL_YIELD = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, dried_kelp_block: 20, stick: 0.5, bamboo: 0.25 };
const fuelYield = (name) => FUEL_YIELD[name] ?? (/_planks$|_log$|_wood$/.test(name) ? 1.5 : 1);

/** Total of a named item across every slot, not just the first stack. */
const countAllSlots = (bot, name) => bot.inventory.items().reduce((n, i) => (i.name === name ? n + i.count : n), 0);

/**
 * Pick the fuel that can actually finish the batch, preferring proper fuels over
 * burning the planks she needs for crafting.
 */
function chooseFuel(bot, batch) {
  const owned = FUELS.map((name) => {
    const have = countAllSlots(bot, name);
    if (!have) return null;
    const per = fuelYield(name);
    return { name, have, per, units: Math.max(1, Math.ceil(batch / per)), covers: have * per };
  }).filter(Boolean);
  if (!owned.length) return null;
  // Anything that can cover the whole batch wins; otherwise take the biggest burn.
  const enough = owned.filter((f) => f.covers >= batch);
  const pick = (enough.length ? enough : owned.sort((a, b) => b.covers - a.covers))[0];
  return { ...pick, units: Math.min(pick.have, pick.units) };
}

const count = (bot, name) => bot.inventory.items().reduce((n, i) => (i.name === name ? n + i.count : n), 0);
const findItem = (bot, name) => bot.inventory.items().find((i) => i.name === name);

/** Material tallies, used to decide whether she can simply make a new bench here. */
const plankCount = (bot) => Object.values(PLANK_FROM_LOG).reduce((n, p) => n + count(bot, p), 0);
const logCount = (bot) => Object.keys(PLANK_FROM_LOG).reduce((n, l) => n + count(bot, l), 0);
const findAny = (bot, names) => {
  for (const n of names) {
    const it = findItem(bot, n);
    if (it) return it;
  }
  return null;
};

/** Convert logs to planks automatically — she should never be blocked on this. */
async function ensurePlanks(bot, task, needed = 4) {
  const plankNames = Object.values(PLANK_FROM_LOG);
  const have = plankNames.reduce((n, p) => n + count(bot, p), 0);
  if (have >= needed) return true;

  for (const [logName, plankName] of Object.entries(PLANK_FROM_LOG)) {
    const logs = count(bot, logName);
    if (!logs) continue;
    const id = bot.mcData.itemsByName[plankName]?.id;
    if (id == null) continue;
    const recipes = bot.recipesFor(id, null, 1, null);
    if (!recipes.length) continue;
    const times = Math.min(logs, Math.ceil((needed - have) / 4));
    try {
      await bot.craft(recipes[0], Math.max(1, times), null);
      log.act(`made ${times * 4} ${plankName}`);
      return true;
    } catch {}
  }
  return false;
}

async function ensureSticks(bot, task, needed = 2) {
  if (count(bot, 'stick') >= needed) return true;
  await ensurePlanks(bot, task, 2);
  await wait(250); // let the plank craft land before asking what is craftable
  const id = bot.mcData.itemsByName.stick.id;
  const recipes = bot.recipesFor(id, null, 1, null);
  if (!recipes.length) return false;
  // Try each variant: the first may want a plank type she does not have.
  for (const recipe of recipes) {
    try {
      await bot.craft(recipe, Math.ceil(needed / 4), null);
      return true;
    } catch {
      /* next variant */
    }
  }
  return false;
}

/** A crafting table within reach — found, placed, or crafted then placed. */
/**
 * A crafting table she can reach.
 *
 * Two failed approaches before this one. Leaving the bench behind meant every craft
 * after she walked away failed with "needs a crafting table and she has none". Picking
 * it up after every craft was worse — she reclaimed it, immediately needed it again,
 * and burned ten failures a session on the churn.
 *
 * A player leaves a bench at camp and walks back to it. So: look nearby, then walk to
 * the one she remembers placing, and only build a new one if neither is available.
 */
export async function ensureCraftingTable(bot, task) {
  const TABLE_ID = bot.mcData.blocksByName.crafting_table.id;

  // 1. Already within arm's reach.
  const near = bot.findBlock({ matching: TABLE_ID, maxDistance: 4 });
  if (near) return near;

  /**
   * 2. Can she just put one down right here?
   *
   * This is checked BEFORE walking anywhere, and that order matters. She sealed
   * herself inside a hillside shelter, leaving her bench outside the wall, and then
   * every craft spent 48 seconds failing to path to it — cancelled by the watchdog,
   * retried, cancelled again, while her health drained. Two planks solve that
   * instantly. Walking across the map to a specific table is the last resort, not the
   * first instinct.
   */
  const carried = findItem(bot, 'crafting_table');
  if (carried) {
    const placed = await placeSupportBlock(bot, task, carried);
    if (placed) {
      lastPlacedTable = placed.position.clone();
      mem.addWaypoint('bench', placed.position);
      return placed;
    }
  }

  // 3. One in view, worth a short walk.
  let table = bot.findBlock({ matching: TABLE_ID, maxDistance: 32 });
  if (table) {
    const res = await goTo(bot, task, table.position.x, table.position.y, table.position.z, { range: 2, timeoutMs: 20000 });
    if (res.ok) {
      const found = bot.findBlock({ matching: TABLE_ID, maxDistance: 4 });
      if (found) return found;
    }
    table = null;
  }

  // 4. Make one and put it down.
  let item = findItem(bot, 'crafting_table');
  if (!item) {
    await ensurePlanks(bot, task, 4);
    const id = bot.mcData.itemsByName.crafting_table.id;
    const recipes = bot.recipesFor(id, null, 1, null);
    if (recipes.length) {
      try {
        await bot.craft(recipes[0], 1, null);
        item = findItem(bot, 'crafting_table');
      } catch {}
    }
  }
  if (item) {
    const placed = await placeSupportBlock(bot, task, item);
    if (placed) {
      lastPlacedTable = placed.position.clone();
      // Remember where camp is, so she can come back to this bench later.
      mem.addWaypoint('bench', placed.position);
      log.act(`bench set up at ${placed.position.x},${placed.position.y},${placed.position.z}`);
      return placed;
    }
  }

  /**
   * 5. LAST RESORT: the bench she remembers placing.
   *
   * This used to be gated on `!canMakeOne`, so while she carried a single log she
   * would never walk back to a perfectly good bench — she would try to place a new
   * one, fail on the terrain, and report "no crafting table" forever. Reaching this
   * point means placing has already failed, so distance is the only question left.
   */
  const remembered = mem.all.waypoints?.bench;
  if (remembered) {
    const pos = new Vec3(remembered.x, remembered.y, remembered.z);
    if (bot.entity.position.distanceTo(pos) <= 96) {
      log.act(`nowhere to place a bench here — walking back to the one at ${pos.x},${pos.y},${pos.z}`);
      const res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 45000 });
      if (res.ok) {
        const found = bot.findBlock({ matching: TABLE_ID, maxDistance: 6 });
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Take the bench with her.
 *
 * She placed a crafting table, crafted, then walked sixty blocks away — and every
 * later craft failed with "needs a crafting table and she has none" while her table
 * sat abandoned on a hillside. That single behaviour blocked the entire tool chain:
 * no stone pickaxe, so no iron, so no progress. A real player picks the bench back up.
 */
let lastPlacedTable = null;

export async function reclaimCraftingTable(bot, task) {
  if (!lastPlacedTable) return false;
  const pos = lastPlacedTable;
  lastPlacedTable = null;

  const block = bot.blockAt(pos);
  if (!block || block.name !== 'crafting_table') return false;
  if (bot.entity.position.distanceTo(pos) > 4.5) return false;

  try {
    const { digBlock, collectDrops } = await import('./gather.js');
    if (await digBlock(bot, task, block, { safety: false })) {
      await collectDrops(bot, task, { radius: 4, quiet: true });
      log.debug('picked the crafting table back up');
      return true;
    }
  } catch {}
  return false;
}

const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

/** Cheap blocks she is willing to spend to build herself somewhere to stand. */
const FOOTING = ['dirt', 'cobblestone', 'stone', 'cobbled_deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'gravel', 'sand', 'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks'];

/**
 * Try to put `item` at exactly `target`, using ANY solid neighbour as the reference
 * face rather than insisting on the floor. Returns the placed block or null.
 */
async function placeAtCell(bot, task, item, target) {
  for (const face of FACES) {
    task.check();
    const ref = bot.blockAt(target.plus(face));
    if (!ref || ref.boundingBox !== 'block') continue;
    if (/water|lava|bedrock/.test(ref.name)) continue;
    try {
      const held = bot.inventory.items().find((i) => i.name === item.name);
      if (!held) return null;
      if (bot.heldItem?.name !== held.name) await bot.equip(held, 'hand');
      await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(ref, face.scaled(-1));
      await wait(180); // let the server confirm before believing it
      const now = bot.blockAt(target);
      if (now && now.name === item.name) return now;
    } catch (err) {
      if (task.aborted) throw new AbortError();
    }
  }
  return null;
}

/**
 * Put a block-item down somewhere she can reach, and return the placed block.
 *
 * THE ONE THAT BLOCKED THE ENTIRE LADDER.
 *
 * The old version tried six cells at exactly foot level and demanded each be air
 * sitting on a solid floor. On a steep mountain spawn every single candidate failed, so
 * ensureCraftingTable returned null and `craft` reported "wooden_pickaxe needs a
 * crafting table and she has none" while she was carrying one. No bench meant no wooden
 * pickaxe, which meant no stone, no iron, nothing — 13 minutes of a live run spent
 * failing to place a block she owned.
 *
 * So this escalates instead of giving up:
 *   1. air cells all around her, at foot level and a step up or down
 *   2. any solid neighbour as the reference face, not only the floor
 *   3. build her own footing from a spare block when a cell is floating in space
 *   4. dig a pocket out of the hillside when she is genuinely boxed in
 */
async function placeSupportBlock(bot, task, item) {
  const base = bot.entity.position.floored();
  const ring = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]];
  const cells = [];
  for (const dy of [0, 1, -1]) for (const [dx, dz] of ring) cells.push(base.offset(dx, dy, dz));

  const standable = (p) => !p.equals(base) && !p.equals(base.offset(0, 1, 0));
  const isAir = (p) => {
    const b = bot.blockAt(p);
    return b && b.boundingBox === 'empty' && !/water|lava/.test(b.name);
  };
  const reachable = (p) => bot.entity.position.distanceTo(p) <= 4.4;

  // 1 + 2. Somewhere already suitable.
  for (const cell of cells) {
    if (!standable(cell) || !isAir(cell) || !reachable(cell)) continue;
    const placed = await placeAtCell(bot, task, item, cell);
    if (placed) return placed;
  }

  // 3. Nothing had a face to place against — give a cell a floor of its own first.
  const footing = findAny(bot, FOOTING);
  if (footing && footing.name !== item.name) {
    for (const cell of cells) {
      if (!standable(cell) || !isAir(cell) || !reachable(cell)) continue;
      const under = cell.offset(0, -1, 0);
      if (!isAir(under)) continue;
      const madeFloor = await placeAtCell(bot, task, footing, under);
      if (!madeFloor) continue;
      log.debug(`built footing at ${under.x},${under.y},${under.z} to stand a ${item.name} on`);
      const placed = await placeAtCell(bot, task, item, cell);
      if (placed) return placed;
    }
  }

  // 4. Walled in. Carve a pocket at chest height and use that.
  const { digBlock } = await import('./gather.js');
  for (const cell of cells.slice(0, 12)) {
    if (!standable(cell) || !reachable(cell)) continue;
    const b = bot.blockAt(cell);
    if (!b || b.boundingBox !== 'block') continue;
    if (/bedrock|water|lava|chest|furnace|crafting_table|bed|spawner/.test(b.name)) continue;
    if (!(await digBlock(bot, task, b, { harvest: false }))) continue;
    log.debug(`dug a pocket at ${cell.x},${cell.y},${cell.z} to place a ${item.name}`);
    const placed = await placeAtCell(bot, task, item, cell);
    if (placed) return placed;
  }

  log.warn(`could not find anywhere to place a ${item.name} at ${base.x},${base.y},${base.z}`);
  return null;
}

/** What is still missing for a recipe, by name. */
function missingFor(bot, recipe) {
  const missing = [];
  for (const d of recipe.delta || []) {
    if (d.count >= 0) continue;
    const name = bot.mcData.items[d.id]?.name;
    if (!name) continue;
    const need = -d.count;
    const have = count(bot, name);
    if (have < need) missing.push({ name, need: need - have });
  }
  return missing;
}

/**
 * craft{item,count}. Resolves planks/sticks automatically, places a table if needed,
 * and reports precisely what it lacks so the brain can go get it.
 */
export async function craft(bot, task, { item, count: want = 1, optional = false, depth = 0 } = {}) {
  const name = String(item).toLowerCase().replace(/\s+/g, '_');
  const def = bot.mcData.itemsByName[name] || bot.mcData.blocksByName[name];
  if (!def) return { ok: !!optional, reason: `no such item "${item}"` };

  /**
   * NEVER TRY TO *CRAFT* A FURNACE PRODUCT.
   *
   * An ingot has a crafting recipe — nine of them come back out of a block — so asking to
   * craft one sends the resolver into a circle. Observed live, repeatedly:
   *   craft iron_ingot -> FAILED: need 1x iron_block for iron_ingot
   *   craft iron_block -> FAILED: need 9x iron_ingot for iron_block
   * Iron comes out of a furnace. Say so, so the layer above smelts instead of looping.
   */
  if (SMELT_INPUT[name] && count(bot, name) < want) {
    const haveInput = SMELT_INPUT[name].some((n) => count(bot, n) > 0);
    return {
      ok: !!optional,
      reason: haveInput
        ? `${name} must be smelted, not crafted`
        : `need ${SMELT_INPUT[name][0]} to smelt into ${name}`,
      mustSmelt: name,
    };
  }
  const id = bot.mcData.itemsByName[name]?.id ?? def.id;

  if (count(bot, name) >= want) return { ok: true, detail: `already have ${want} ${name}` };

  // Common prerequisites first.
  if (/planks$/.test(name)) await ensurePlanks(bot, task, want);
  if (/_pickaxe|_sword|_axe|_shovel|_hoe|torch|bow|ladder|sign|arrow|rail/.test(name)) {
    // Scaled by the requested count. Reserving materials for one and then asking for
    // two is what produced "missing ingredient" with a pack full of logs.
    await ensureSticks(bot, task, 2 * want);
    // Wooden and stone tools also need planks or cobble for the head. Only sticks
    // were being reserved, so she would craft one tool and then be a plank short of
    // the next one with logs still in her pack.
    if (/^wooden_/.test(name)) await ensurePlanks(bot, task, 4 * want);
  }
  if (/table|chest|door|boat|stairs|slab|fence|bowl|bucket|shield|barrel/.test(name)) await ensurePlanks(bot, task, 6);

  /**
   * Inventory changes from the prerequisite crafts above need a moment to land
   * before recipesFor sees them. Without this pause she would craft 12 birch
   * planks and then be told she needs 4 pale_oak_planks, because recipesFor still
   * saw an empty inventory and fell back to reporting an arbitrary recipe's
   * missing ingredients.
   */
  await wait(260);

  // Try without a table first, then with one.
  let recipes = bot.recipesFor(id, null, 1, null);
  let table = null;
  if (!recipes.length) {
    await wait(320);
    recipes = bot.recipesFor(id, null, 1, null);
  }
  if (!recipes.length) {
    table = await ensureCraftingTable(bot, task);
    if (table) recipes = bot.recipesFor(id, null, 1, table);
  }

  if (!recipes.length) {
    const all = bot.recipesAll(id, null, table);

    /**
     * A 3x3 recipe returns nothing at all without a bench, which is indistinguishable
     * from "impossible" unless you go and get one first. Get the bench, then re-ask.
     *
     * Reporting matters here: this path previously returned "wooden_sword needs a
     * crafting table" even when she was standing at a table she had just placed and
     * the real problem was two missing planks. A wrong diagnosis sent me looking in
     * the wrong place, so now it falls through to the real materials check.
     */
    let allWithBench = all;
    if (!allWithBench.length && !table) {
      const bench = await ensureCraftingTable(bot, task);
      if (bench) {
        table = bench;
        const retry = bot.recipesFor(id, null, 1, bench);
        if (retry.length) recipes = retry;
        allWithBench = bot.recipesAll(id, null, bench);
      }
    }

    if (!recipes.length && !allWithBench.length) {
      return {
        ok: !!optional,
        reason: table ? `${name} is not craftable` : `${name} needs a crafting table and she has none`,
      };
    }

    if (!recipes.length) {
      /**
       * Pick the recipe she is CLOSEST to being able to make.
       *
       * Taking all[0] blindly is why she kept reporting "need 4x pale_oak_planks"
       * while holding a stack of birch: every wood type is a separate recipe, and the
       * first one returned is arbitrary. Scoring by how much is missing makes her
       * choose the variant matching the wood she actually has.
       */
      const scored = allWithBench
        .map((r) => {
          const missing = missingFor(bot, r);
          return { recipe: r, missing, cost: missing.reduce((s, m) => s + m.need, 0) };
        })
        .sort((a, b) => a.cost - b.cost);
      const best = scored[0];

      if (depth < 2 && best.missing.length) {
        for (const m of best.missing) {
          task.check();
          /**
           * Ask for the TOTAL she needs to end up holding, not the shortfall.
           *
           * missingFor already subtracted what she has, so passing the shortfall made
           * the sub-craft hit its own "already have N" early return and do nothing.
           * Live consequence: she had 1 plank, needed 2 for a wooden sword, and the
           * sub-craft for "1 dark_oak_planks" saw 1 in the pack and returned success
           * without crafting — so the sword failed forever and the ladder deadlocked
           * on wood_tools with a chest full of logs.
           */
          const target = count(bot, m.name) + m.need;
          const sub = await craft(bot, task, { item: m.name, count: target, optional: true, depth: depth + 1 });
          if (!sub.ok) log.debug(`sub-craft ${m.name} x${target} failed: ${sub.reason || ''}`);
        }
        await wait(300);
        recipes = bot.recipesFor(id, null, 1, table || undefined);
      }

      if (!recipes.length) {
        const list = best.missing.map((m) => `${m.need}x ${m.name}`).join(', ') || 'materials';
        return { ok: !!optional, reason: `need ${list} for ${name}`, missing: best.missing };
      }
    }
  }

  if (table && bot.entity.position.distanceTo(table.position) > 3.2) {
    await goTo(bot, task, table.position.x, table.position.y, table.position.z, { range: 2 });
  }

  /**
   * Craft ONE AT A TIME, re-checking materials between each.
   *
   * `recipesFor(..., minResultCount = 1, ...)` only promises she can make a single one,
   * but the old code computed `times` from the requested count and passed it straight to
   * bot.craft — so asking for two wooden pickaxes threw "missing ingredient" even with
   * thirty logs in her pack, because six planks had never been prepared. That failure
   * then triggered a wood repair, and a live run spent five and a half minutes chopping
   * trees it did not need, three times over.
   *
   * Crafting in single units also means a partial result is kept rather than lost.
   */
  let lastErr = null;
  for (const recipe of recipes) {
    task.check();
    const per = recipe.result?.count || 1;
    let made = 0;

    while (count(bot, name) < want) {
      task.check();
      try {
        await bot.craft(recipe, 1, table || undefined);
        made += per;
        await wait(120); // let the inventory update land before the next check
      } catch (err) {
        if (task.aborted) throw new AbortError();
        lastErr = err;
        break;
      }
    }

    if (made > 0) {
      mem.bump('itemsCrafted', made);
      const have = count(bot, name);
      log.act(`crafted ${made}x ${name}${have < want ? ` (wanted ${want}, materials ran out)` : ''}`);
      return { ok: true, detail: `crafted ${made}x ${name}`, got: made };
    }
  }
  return { ok: !!optional, reason: `craft ${name} failed: ${lastErr?.message || 'no usable recipe'}` };
}

/** A furnace within reach — found, placed, or crafted then placed. */
export async function ensureFurnace(bot, task) {
  let f = bot.findBlock({
    matching: [bot.mcData.blocksByName.furnace.id, bot.mcData.blocksByName.blast_furnace?.id].filter((x) => x != null),
    maxDistance: 24,
  });
  if (f) {
    if (bot.entity.position.distanceTo(f.position) > 3.2) {
      const res = await goTo(bot, task, f.position.x, f.position.y, f.position.z, { range: 2 });
      if (res.ok) return f;
    } else return f;
  }
  let item = findItem(bot, 'furnace');
  if (!item) {
    const made = await craft(bot, task, { item: 'furnace', count: 1 });
    if (!made.ok) return null;
    item = findItem(bot, 'furnace');
  }
  if (!item) return null;
  const placed = await placeSupportBlock(bot, task, item);
  if (placed) {
    /**
     * Remember it, exactly like the bench.
     *
     * Placing the furnace takes it out of her inventory, and the stone_tools rung asked
     * whether she OWNED one — so smelting un-did the rung and the ladder bounced
     * stone_tools -> food_security -> stone_tools on a live run. A furnace she built and
     * can walk back to is a furnace she has.
     */
    mem.addWaypoint('furnace', placed.position);
    log.act(`furnace set up at ${placed.position.x},${placed.position.y},${placed.position.z}`);
  }
  return placed;
}

/**
 * smelt{item,count}. Works out the input from the desired output, loads fuel,
 * waits for the burn, takes the result.
 */
export async function smelt(bot, task, { item, count: want = 1, any } = {}) {
  const outName = String(item).toLowerCase().replace(/\s+/g, '_');
  let inputs = SMELT_INPUT[outName];

  if (any === 'meat') inputs = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'];
  if (!inputs) return { ok: false, reason: `don't know how to smelt ${outName}` };

  const input = findAny(bot, inputs);
  if (!input) return { ok: false, reason: `no ${inputs[0]} to smelt` };

  if (!chooseFuel(bot, 1)) return { ok: false, reason: 'no fuel for the furnace' };

  /**
   * MAKE ROOM BEFORE SMELTING.
   *
   * A live run reached 33 ingots' worth of iron and could not smelt a single one:
   *   smelt -> FAILED: destination full
   * She was carrying 392 items, most of it granite and gravel swept up while branch
   * mining, so the output had nowhere to land. Mining fills a pack with rubble; empty it
   * before asking the furnace for anything.
   */
  const usedSlots = bot.inventory.slots.slice(9, 45).filter(Boolean).length;
  if (usedSlots >= 32) {
    const { dropJunk } = await import('./storage.js');
    log.act(`[smelt] ${usedSlots}/36 slots used — clearing rubble so the ingots have somewhere to go`);
    await dropJunk(bot, task).catch(() => {});
  }

  const block = await ensureFurnace(bot, task);
  if (!block) return { ok: false, reason: 'no furnace available' };

  let furnace;
  try {
    furnace = await bot.openFurnace(block);
  } catch (err) {
    return { ok: false, reason: `cannot open furnace: ${err.message}` };
  }

  // Count the input across every slot — a 33-iron batch can arrive as two stacks.
  const available = inputs.reduce((n, name) => n + countAllSlots(bot, name), 0);
  /**
   * Reclaim whatever a previous, interrupted smelt left behind. A cancelled action (a
   * restart, a mob, a watchdog) used to walk away leaving the ore and the finished ingots
   * sitting in the furnace.
   */
  try {
    if (furnace.outputItem()) {
      const back = await furnace.takeOutput().catch(() => null);
      if (back) log.act(`[smelt] reclaimed ${back.count}x ${back.name} left in the furnace`);
    }
  } catch {}

  /**
   * ONLY COMMIT WHAT HER FUEL CAN ACTUALLY COOK.
   *
   * The old code shovelled all 33 ore in and hoped. With six oak logs — nine items of burn
   * for a thirty-three item job — it ran dry, returned, and left everything in the furnace.
   * Loading a batch her fuel can finish means there is nothing to abandon.
   */
  const fuelPlan = chooseFuel(bot, want);
  if (!fuelPlan) return { ok: false, reason: 'no fuel for the furnace' };
  const canBurn = Math.max(1, Math.floor(fuelPlan.have * fuelPlan.per));
  const batch = Math.min(want, available, 64, canBurn);
  if (canBurn < want) {
    log.act(`[smelt] fuel only covers ${canBurn} of ${want} ${outName} — smelting ${batch} this pass`);
  }

  let produced = 0;
  try {
    const fuel = chooseFuel(bot, batch);
    if (!fuel) return { ok: false, reason: 'no fuel for the furnace' };
    const fuelItem = findItem(bot, fuel.name);
    await furnace.putFuel(fuelItem.type, null, fuel.units).catch(() => {});
    await furnace.putInput(input.type, null, batch);
    log.act(`smelting ${batch}x ${input.name} -> ${outName} (${fuel.units}x ${fuel.name} as fuel)`);

    const deadline = Date.now() + batch * 12000 + 20000;
    let lastBeat = Date.now();
    while (Date.now() < deadline) {
      task.check();
      await wait(1200);
      const out = furnace.outputItem();
      if (out && out.count >= 1) {
        const taken = await furnace.takeOutput().catch(() => null);
        if (taken) produced += taken.count;
        if (produced >= batch) break;
      }

      /**
       * Top the fuel back up mid-burn instead of stopping short.
       *
       * A 33-iron batch needs 5 coal; if she only had 2 in the furnace the old loop
       * saw an empty fuel slot, broke out with 16 ingots, and the iron rung un-did
       * itself. Refuelling while there is still input is what a player does.
       */
      if (!furnace.fuel && furnace.inputItem() && produced < batch) {
        const more = chooseFuel(bot, batch - produced);
        const moreItem = more && findItem(bot, more.name);
        if (moreItem) {
          await furnace.putFuel(moreItem.type, null, more.units).catch(() => {});
          log.debug(`refuelled the furnace with ${more.units}x ${more.name}`);
        } else {
          log.warn(`out of fuel after ${produced}/${batch} ${outName}`);
          break;
        }
      }

      if (Date.now() - lastBeat > 15000) {
        lastBeat = Date.now();
        log.act(`[smelt] ${produced}/${batch} ${outName} | hp ${Math.round(bot.health)} | food ${bot.food}`);
      }

      if (!furnace.inputItem() && !furnace.fuel) {
        const out2 = furnace.outputItem();
        if (out2) {
          const taken = await furnace.takeOutput().catch(() => null);
          if (taken) produced += taken.count;
        }
        break;
      }
    }
  } catch (err) {
    if (task.aborted) {
      try {
        furnace.close();
      } catch {}
      throw new AbortError();
    }
    return { ok: produced > 0, reason: err.message, detail: `smelted ${produced}` };
  } finally {
    /**
     * NEVER WALK AWAY FROM HER MATERIALS.
     *
     * This is the one that cost two full mining trips. A live run left 24 raw_iron and 9
     * finished ingots sitting in a furnace at -4,26,-42 because the smelt ran out of fuel
     * and simply returned — then she spent another twenty minutes underground mining iron
     * she already owned. Whatever happens, everything comes back out before she leaves.
     */
    try {
      const out = furnace.outputItem();
      if (out) {
        const taken = await furnace.takeOutput().catch(() => null);
        if (taken) {
          produced += taken.count;
          log.act(`[smelt] took the last ${taken.count}x ${taken.name} out`);
        }
      }
    } catch {}
    try {
      if (furnace.inputItem()) {
        const back = await furnace.takeInput().catch(() => null);
        if (back) log.act(`[smelt] reclaimed ${back.count}x ${back.name} from the furnace — not leaving it behind`);
      }
    } catch {}
    try {
      furnace.close();
    } catch {}
  }

  return { ok: produced > 0, detail: `smelted ${produced}x ${outName}`, got: produced };
}

/**
 * Empty a furnace she has used before.
 *
 * Recovery for material stranded by an interrupted or under-fuelled smelt. She had 33
 * ingots' worth of iron locked in a furnace while the ladder sent her back down the mine
 * for more, because nothing ever went back to check.
 */
export async function emptyFurnace(bot, task) {
  const ids = [bot.mcData.blocksByName.furnace?.id, bot.mcData.blocksByName.blast_furnace?.id].filter((x) => x != null);

  const drain = async (block) => {
    if (!block) return 0;
    if (bot.entity.position.distanceTo(block.position) > 3.2) {
      const res = await goTo(bot, task, block.position.x, block.position.y, block.position.z, { range: 2, timeoutMs: 30000 });
      if (!res.ok) return 0;
    }
    let furnace;
    try {
      furnace = await bot.openFurnace(block);
    } catch {
      return 0;
    }
    let got = 0;
    try {
      for (const take of ['takeOutput', 'takeInput', 'takeFuel']) {
        try {
          const item = await furnace[take]().catch(() => null);
          if (item) {
            got += item.count;
            log.act(`[furnace] recovered ${item.count}x ${item.name} at ${block.position.x},${block.position.y},${block.position.z}`);
          }
        } catch {}
      }
    } finally {
      try {
        furnace.close();
      } catch {}
    }
    return got;
  };

  let got = 0;

  // 1. Anything right here.
  got += await drain(bot.findBlock({ matching: ids, maxDistance: 16 }));

  /**
   * 2. AND the one she remembers, even if a closer one existed.
   *
   * Checking only the nearest furnace was not enough: she placed a second furnace to cook
   * food, that became the nearest, and 24 raw_iron plus 9 ingots stayed locked in the first
   * one while she went back down the mine for more.
   */
  const wp = mem.all.waypoints?.furnace;
  if (wp) {
    const pos = new Vec3(wp.x, wp.y, wp.z);
    const already = bot.entity.position.distanceTo(pos) <= 4;
    if (!already && bot.entity.position.distanceTo(pos) <= 160) {
      const res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 90000 });
      if (res.ok) got += await drain(bot.findBlock({ matching: ids, maxDistance: 6 }));
    }
  }

  return { ok: true, detail: got ? `recovered ${got} items from furnaces` : 'furnaces were empty', got };
}
