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

const count = (bot, name) => bot.inventory.items().reduce((n, i) => (i.name === name ? n + i.count : n), 0);
const findItem = (bot, name) => bot.inventory.items().find((i) => i.name === name);
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
export async function ensureCraftingTable(bot, task) {
  let table = bot.findBlock({ matching: bot.mcData.blocksByName.crafting_table.id, maxDistance: 24 });
  if (table) {
    if (bot.entity.position.distanceTo(table.position) > 3.2) {
      const res = await goTo(bot, task, table.position.x, table.position.y, table.position.z, { range: 2 });
      if (!res.ok) table = null;
    }
    if (table) return table;
  }

  let item = findItem(bot, 'crafting_table');
  if (!item) {
    await ensurePlanks(bot, task, 4);
    const id = bot.mcData.itemsByName.crafting_table.id;
    const recipes = bot.recipesFor(id, null, 1, null);
    if (!recipes.length) return null;
    try {
      await bot.craft(recipes[0], 1, null);
      item = findItem(bot, 'crafting_table');
    } catch {
      return null;
    }
  }
  if (!item) return null;

  const placed = await placeSupportBlock(bot, task, item);
  return placed;
}

/** Place a block-item next to her on solid ground and return the placed block. */
async function placeSupportBlock(bot, task, item) {
  const base = bot.entity.position.floored();
  const spots = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(1, 0, 1), new Vec3(-1, 0, -1)];
  for (const off of spots) {
    task.check();
    const target = base.plus(off);
    const at = bot.blockAt(target);
    const floor = bot.blockAt(target.offset(0, -1, 0));
    const head = bot.blockAt(target.offset(0, 1, 0));
    if (!at || !floor || !head) continue;
    if (at.boundingBox !== 'empty' || floor.boundingBox !== 'block') continue;
    try {
      await bot.equip(item, 'hand');
      await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(floor, new Vec3(0, 1, 0));
      const b = bot.blockAt(target);
      if (b && b.name === item.name) return b;
    } catch {}
  }
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
  const id = bot.mcData.itemsByName[name]?.id ?? def.id;

  if (count(bot, name) >= want) return { ok: true, detail: `already have ${want} ${name}` };

  // Common prerequisites first.
  if (/planks$/.test(name)) await ensurePlanks(bot, task, want);
  if (/_pickaxe|_sword|_axe|_shovel|_hoe|torch|bow|ladder|sign|arrow|rail/.test(name)) await ensureSticks(bot, task, 2);
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

    if (!all.length) {
      // Distinguish "impossible" from "needs a bench" — the old message claimed
      // wooden_pickaxe was not craftable, which was simply wrong and unactionable.
      if (!table) {
        const bench = await ensureCraftingTable(bot, task);
        if (bench) {
          const retry = bot.recipesFor(id, null, 1, bench);
          if (retry.length) {
            recipes = retry;
            table = bench;
          }
        }
        if (!recipes.length) return { ok: !!optional, reason: `${name} needs a crafting table` };
      } else {
        return { ok: !!optional, reason: `${name} is not craftable` };
      }
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
      const scored = all
        .map((r) => {
          const missing = missingFor(bot, r);
          return { recipe: r, missing, cost: missing.reduce((s, m) => s + m.need, 0) };
        })
        .sort((a, b) => a.cost - b.cost);
      const best = scored[0];

      if (depth < 2 && best.missing.length) {
        for (const m of best.missing) {
          task.check();
          const sub = await craft(bot, task, { item: m.name, count: m.need, optional: true, depth: depth + 1 });
          if (!sub.ok) log.debug(`sub-craft ${m.name} failed: ${sub.reason || ''}`);
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

  // Walk the candidate list rather than betting everything on the first entry.
  let lastErr = null;
  for (const recipe of recipes) {
    task.check();
    const per = recipe.result?.count || 1;
    const times = Math.max(1, Math.ceil((want - count(bot, name)) / per));
    try {
      await bot.craft(recipe, times, table || undefined);
      mem.bump('itemsCrafted', times * per);
      log.act(`crafted ${times * per}x ${name}`);
      return { ok: true, detail: `crafted ${times * per}x ${name}` };
    } catch (err) {
      if (task.aborted) throw new AbortError();
      lastErr = err;
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
  return placeSupportBlock(bot, task, item);
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

  const fuel = findAny(bot, FUELS);
  if (!fuel) return { ok: false, reason: 'no fuel for the furnace' };

  const block = await ensureFurnace(bot, task);
  if (!block) return { ok: false, reason: 'no furnace available' };

  let furnace;
  try {
    furnace = await bot.openFurnace(block);
  } catch (err) {
    return { ok: false, reason: `cannot open furnace: ${err.message}` };
  }

  const batch = Math.min(want, input.count, 32);
  let produced = 0;
  try {
    await furnace.putFuel(fuel.type, null, Math.max(1, Math.ceil(batch / 8))).catch(() => {});
    await furnace.putInput(input.type, null, batch);
    log.act(`smelting ${batch}x ${input.name} -> ${outName}`);

    const deadline = Date.now() + batch * 11000 + 15000;
    while (Date.now() < deadline) {
      task.check();
      await wait(1200);
      const out = furnace.outputItem();
      if (out && out.count >= 1) {
        const taken = await furnace.takeOutput().catch(() => null);
        if (taken) produced += taken.count;
        if (produced >= batch) break;
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
    try {
      furnace.close();
    } catch {}
  }

  return { ok: produced > 0, detail: `smelted ${produced}x ${outName}`, got: produced };
}
