/**
 * The survival ladder.
 *
 * What she does the moment she spawns into a fresh world, with nobody telling her
 * anything: secure food and tools, gear up through stone and iron, go get diamonds,
 * come home alive.
 *
 * Design rule: every stage is defined by a **predicate on current state**, never by a
 * counter. That makes the whole ladder resumable — if she dies at diamond level, or you
 * restart the process, or you hand her a stack of iron, she re-evaluates and resumes at
 * the correct rung instead of starting over. Deterministic, no LLM tokens spent.
 *
 * The brain only gets involved when a stage fails repeatedly or you give an order.
 */

const count = (bot, name) =>
  bot.inventory.items().reduce((n, it) => (it.name === name ? n + it.count : n), 0);

const countAny = (bot, ...names) => names.reduce((n, name) => n + count(bot, name), 0);

const has = (bot, name, n = 1) => count(bot, name) >= n;

const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log'];
const PLANKS = LOGS.map((l) => l.replace('_log', '_planks'));

const logs = (bot) => countAny(bot, ...LOGS);
const planks = (bot) => countAny(bot, ...PLANKS);

const FOODS = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato', 'golden_carrot', 'apple', 'carrot', 'melon_slice', 'sweet_berries'];
const RAW_MEAT = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'];

export const foodCount = (bot) => countAny(bot, ...FOODS);
export const rawMeatCount = (bot) => countAny(bot, ...RAW_MEAT);

const pickTier = (bot) => {
  if (has(bot, 'netherite_pickaxe')) return 5;
  if (has(bot, 'diamond_pickaxe')) return 4;
  if (has(bot, 'iron_pickaxe')) return 3;
  if (has(bot, 'stone_pickaxe')) return 2;
  if (has(bot, 'wooden_pickaxe') || has(bot, 'golden_pickaxe')) return 1;
  return 0;
};

const swordTier = (bot) => {
  if (has(bot, 'netherite_sword')) return 5;
  if (has(bot, 'diamond_sword')) return 4;
  if (has(bot, 'iron_sword')) return 3;
  if (has(bot, 'stone_sword')) return 2;
  if (has(bot, 'wooden_sword')) return 1;
  return 0;
};

const armorPieces = (bot) => {
  const slots = [5, 6, 7, 8];
  return slots.filter((i) => bot.inventory.slots[i]).length;
};

const armorTier = (bot) => {
  const worn = [5, 6, 7, 8].map((i) => bot.inventory.slots[i]?.name || '');
  const rank = (n) =>
    /netherite/.test(n) ? 5 : /diamond/.test(n) ? 4 : /iron/.test(n) ? 3 : /chainmail/.test(n) ? 2 : /golden|leather/.test(n) ? 1 : 0;
  const ranks = worn.map(rank);
  return Math.min(...ranks);
};

/**
 * Ordered rungs. First rung whose `done` is false is the current objective.
 * `actions` is a sequence handed to the executor; `done` is re-checked after each.
 */
export const LADDER = [
  {
    id: 'orient',
    label: 'get bearings and mark home',
    done: (bot, ctx) => !!ctx.memory.all.base,
    actions: () => [{ name: 'markHome', args: {} }, { name: 'equipBest', args: {} }],
  },
  {
    id: 'emergency_food',
    label: 'do not starve',
    // Only a blocker if she is actually hungry with nothing to eat.
    done: (bot) => bot.food > 6 || foodCount(bot) > 0 || rawMeatCount(bot) > 0,
    actions: () => [{ name: 'forageFood', args: { urgent: true } }],
  },
  {
    id: 'wood',
    label: 'gather logs',
    done: (bot) => logs(bot) + Math.floor(planks(bot) / 4) >= 6,
    actions: () => [{ name: 'chopWood', args: { count: 8 } }],
  },
  {
    id: 'wood_tools',
    label: 'crafting table and first pickaxe',
    done: (bot) => pickTier(bot) >= 1 && has(bot, 'crafting_table'),
    actions: () => [
      { name: 'craft', args: { item: 'crafting_table', count: 1 } },
      { name: 'craft', args: { item: 'stick', count: 8 } },
      { name: 'craft', args: { item: 'wooden_pickaxe', count: 1 } },
      { name: 'craft', args: { item: 'wooden_axe', count: 1 } },
    ],
  },
  {
    id: 'stone',
    label: 'mine cobblestone',
    done: (bot) => count(bot, 'cobblestone') >= 22,
    actions: () => [{ name: 'mine', args: { block: 'stone', count: 26 } }],
  },
  {
    id: 'stone_tools',
    label: 'stone kit',
    done: (bot) => pickTier(bot) >= 2 && swordTier(bot) >= 2 && has(bot, 'furnace'),
    actions: () => [
      { name: 'craft', args: { item: 'stone_pickaxe', count: 1 } },
      { name: 'craft', args: { item: 'stone_sword', count: 1 } },
      { name: 'craft', args: { item: 'stone_axe', count: 1 } },
      { name: 'craft', args: { item: 'stone_shovel', count: 1 } },
      { name: 'craft', args: { item: 'furnace', count: 1 } },
      { name: 'equipBest', args: {} },
    ],
  },
  {
    id: 'food_security',
    label: 'stock cooked food',
    // 8 cooked items is enough to survive a full mining trip.
    done: (bot) => foodCount(bot) >= 8,
    actions: () => [
      { name: 'forageFood', args: { target: 10 } },
      { name: 'smelt', args: { item: 'cooked_beef', count: 8, any: 'meat' } },
    ],
  },
  {
    id: 'torches',
    label: 'make torches',
    done: (bot) => count(bot, 'torch') >= 24 || count(bot, 'coal') === 0,
    actions: () => [
      { name: 'mine', args: { block: 'coal_ore', count: 8, optional: true } },
      { name: 'craft', args: { item: 'torch', count: 32 } },
    ],
  },
  {
    id: 'shelter',
    label: 'a safe place to log off and sleep',
    done: (bot, ctx) => !!ctx.memory.all.bed || !!ctx.memory.all.shelterBuilt,
    actions: () => [
      { name: 'shelter', args: {} },
      { name: 'craft', args: { item: 'bed', count: 1, optional: true } },
    ],
  },
  {
    id: 'iron',
    label: 'find iron',
    done: (bot) => countAny(bot, 'raw_iron', 'iron_ingot') >= 24 || armorTier(bot) >= 3,
    actions: (bot, ctx) => [
      { name: 'branchMine', args: { targetY: ctx.config.ironY, ore: 'iron_ore', count: 24 } },
    ],
  },
  {
    id: 'iron_kit',
    label: 'full iron armour, sword, shield',
    done: (bot) => armorPieces(bot) === 4 && armorTier(bot) >= 3 && swordTier(bot) >= 3 && has(bot, 'shield'),
    actions: () => [
      { name: 'smelt', args: { item: 'iron_ingot', count: 24 } },
      { name: 'craft', args: { item: 'iron_pickaxe', count: 1 } },
      { name: 'craft', args: { item: 'iron_sword', count: 1 } },
      { name: 'craft', args: { item: 'iron_helmet', count: 1 } },
      { name: 'craft', args: { item: 'iron_chestplate', count: 1 } },
      { name: 'craft', args: { item: 'iron_leggings', count: 1 } },
      { name: 'craft', args: { item: 'iron_boots', count: 1 } },
      { name: 'craft', args: { item: 'shield', count: 1 } },
      { name: 'equipBest', args: {} },
    ],
  },
  {
    id: 'water_bucket',
    label: 'water bucket for lava and MLG saves',
    done: (bot) => has(bot, 'water_bucket'),
    actions: () => [
      { name: 'craft', args: { item: 'bucket', count: 1 } },
      { name: 'fillBucket', args: { fluid: 'water' } },
    ],
  },
  {
    id: 'diamonds',
    label: 'go get diamonds',
    done: (bot) => countAny(bot, 'diamond') >= 3 || has(bot, 'diamond_pickaxe'),
    actions: (bot, ctx) => [
      { name: 'branchMine', args: { targetY: ctx.config.diamondY, ore: 'diamond_ore', count: 8, lavaCaution: true } },
    ],
  },
  {
    id: 'come_home',
    label: 'bring the loot home alive',
    done: (bot, ctx) => ctx.flags.returnedHome === true,
    actions: () => [
      { name: 'home', args: {} },
      { name: 'deposit', args: { keep: 'gear,food,torch,blocks' } },
      { name: 'markReturned', args: {} },
    ],
  },
  {
    id: 'diamond_kit',
    label: 'diamond gear',
    done: (bot) => pickTier(bot) >= 4 && swordTier(bot) >= 4,
    actions: () => [
      { name: 'craft', args: { item: 'diamond_pickaxe', count: 1 } },
      { name: 'craft', args: { item: 'diamond_sword', count: 1, optional: true } },
      { name: 'equipBest', args: {} },
    ],
  },
  {
    id: 'diamond_armor',
    label: 'full diamond armour',
    done: (bot) => armorPieces(bot) === 4 && armorTier(bot) >= 4,
    actions: (bot, ctx) => [
      { name: 'branchMine', args: { targetY: ctx.config.diamondY, ore: 'diamond_ore', count: 24, lavaCaution: true } },
      { name: 'home', args: {} },
      { name: 'craft', args: { item: 'diamond_helmet', count: 1 } },
      { name: 'craft', args: { item: 'diamond_chestplate', count: 1 } },
      { name: 'craft', args: { item: 'diamond_leggings', count: 1 } },
      { name: 'craft', args: { item: 'diamond_boots', count: 1 } },
      { name: 'equipBest', args: {} },
    ],
  },
];

/** First unmet rung. Null means she has finished the whole ladder. */
export function currentRung(bot, ctx) {
  for (const rung of LADDER) {
    let done = false;
    try {
      done = !!rung.done(bot, ctx);
    } catch {
      done = false;
    }
    if (!done) return rung;
  }
  return null;
}

export function ladderProgress(bot, ctx) {
  const rows = LADDER.map((r) => {
    let done = false;
    try {
      done = !!r.done(bot, ctx);
    } catch {}
    return { id: r.id, label: r.label, done };
  });
  const doneCount = rows.filter((r) => r.done).length;
  return { rows, doneCount, total: rows.length, current: currentRung(bot, ctx)?.id ?? 'complete' };
}

export const ladderStatus = {
  count,
  countAny,
  has,
  logs,
  planks,
  pickTier,
  swordTier,
  armorPieces,
  armorTier,
  foodCount,
  rawMeatCount,
};
