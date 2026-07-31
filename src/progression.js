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

/**
 * EVERY slot, including worn armour (5-8) and the off-hand (45).
 *
 * `bot.inventory.items()` only covers slots 9-44, so the moment she equipped something
 * it vanished from these predicates. Two rungs un-did themselves because of it: the
 * shield moved to the off-hand and `has(bot,'shield')` went false, so `iron_kit`
 * re-ran forever, and armour she was wearing stopped counting as armour she owned.
 * Anything that asks "does she own this" must look at the whole window.
 */
const ARMOUR_AND_OFFHAND = [5, 6, 7, 8, 45];

const allSlots = (bot) => {
  const inv = bot?.inventory;
  if (!inv) return [];
  const out = typeof inv.items === 'function' ? [...inv.items()] : [];
  // Indexed by key rather than filtered, so this works whether `slots` is a real
  // array from mineflayer or a sparse object from a test fixture.
  const slots = inv.slots || {};
  for (const i of ARMOUR_AND_OFFHAND) if (slots[i]) out.push(slots[i]);
  return out;
};
const ownedCount = (bot, name) => allSlots(bot).reduce((n, it) => (it.name === name ? n + (it.count ?? 1) : n), 0);
const owns = (bot, name, n = 1) => ownedCount(bot, name) >= n;

/**
 * Ingot cost of anything iron she might be holding or wearing.
 *
 * Used to make the iron rung MONOTONIC. The old predicate counted loose ingots only,
 * so smelting and then crafting the armour spent them, the count fell back under the
 * target, and the ladder sent her underground to mine iron she had already mined and
 * was currently wearing. That is the "smelting part of the iron un-does the iron stage"
 * oscillation, and counting invested iron is what kills it.
 */
const IRON_COST = {
  raw_iron: 1, iron_ingot: 1, iron_block: 9,
  iron_helmet: 5, iron_chestplate: 8, iron_leggings: 7, iron_boots: 4,
  iron_pickaxe: 3, iron_sword: 2, iron_axe: 3, iron_shovel: 1, iron_hoe: 2,
  shield: 1, bucket: 3, water_bucket: 3, lava_bucket: 3, powder_snow_bucket: 3,
  shears: 2, flint_and_steel: 1, iron_door: 6, iron_trapdoor: 4, hopper: 5,
  cauldron: 7, iron_bars: 1, chain: 1, tripwire_hook: 1, rail: 1,
};

export const ironBudget = (bot) =>
  allSlots(bot).reduce((n, it) => n + (IRON_COST[it.name] || 0) * (it.count ?? 1), 0);

/**
 * The exact iron kit this project is judged on.
 *   helmet 5 + chestplate 8 + leggings 7 + boots 4 + pickaxe 3 + sword 2 + shield 1 = 30
 * plus 3 for the water bucket the next rung wants. The old target of 24 was short by
 * a third and made the full set arithmetically impossible.
 */
export const IRON_FOR_KIT = 30;
export const IRON_TARGET = IRON_FOR_KIT + 3;

/**
 * Has the iron problem been solved, one way or another? Either she has mined the budget,
 * or she is already standing in iron-tier-or-better gear. Shared by the iron rung and by
 * its preparation rung, which is pointless once this is true.
 */
const ironSecured = (bot) =>
  ironBudget(bot) >= IRON_TARGET || (wearingFullIron(bot) && pickTier(bot) >= 3 && swordTier(bot) >= 3);

/**
 * All four pieces worn, each one actually iron (or better) and in its own slot.
 *
 * Counting "four occupied armour slots" would happily accept a leather cap and three
 * gold boots, so the slot and the material are both checked.
 */
const IRON_SET = { 5: 'iron_helmet', 6: 'iron_chestplate', 7: 'iron_leggings', 8: 'iron_boots' };
export const wearingFullIron = (bot) =>
  Object.entries(IRON_SET).every(([slot, name]) => {
    const it = bot.inventory?.slots?.[Number(slot)];
    if (!it) return false;
    const kind = name.split('_')[1]; // helmet / chestplate / leggings / boots
    return new RegExp(`^(iron|diamond|netherite)_${kind}$`).test(it.name);
  });

const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log'];
const PLANKS = LOGS.map((l) => l.replace('_log', '_planks'));

const logs = (bot) => countAny(bot, ...LOGS);
const planks = (bot) => countAny(bot, ...PLANKS);

export const BED_NAMES = ['white_bed', 'red_bed', 'blue_bed', 'green_bed', 'yellow_bed', 'black_bed', 'brown_bed', 'cyan_bed', 'gray_bed', 'light_blue_bed', 'light_gray_bed', 'lime_bed', 'magenta_bed', 'orange_bed', 'pink_bed', 'purple_bed'];

const FOODS = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato', 'golden_carrot', 'apple', 'carrot', 'melon_slice', 'sweet_berries'];
const RAW_MEAT = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon'];

export const foodCount = (bot) => countAny(bot, ...FOODS);
export const rawMeatCount = (bot) => countAny(bot, ...RAW_MEAT);

const pickTier = (bot) => {
  if (owns(bot, 'netherite_pickaxe')) return 5;
  if (owns(bot, 'diamond_pickaxe')) return 4;
  if (owns(bot, 'iron_pickaxe')) return 3;
  if (owns(bot, 'stone_pickaxe')) return 2;
  if (owns(bot, 'wooden_pickaxe') || owns(bot, 'golden_pickaxe')) return 1;
  return 0;
};

const swordTier = (bot) => {
  if (owns(bot, 'netherite_sword')) return 5;
  if (owns(bot, 'diamond_sword')) return 4;
  if (owns(bot, 'iron_sword')) return 3;
  if (owns(bot, 'stone_sword')) return 2;
  if (owns(bot, 'wooden_sword')) return 1;
  return 0;
};

const armorPieces = (bot) => {
  const slots = [5, 6, 7, 8];
  return slots.filter((i) => bot.inventory.slots[i]).length;
};

/**
 * Enchantment detection via prismarine-item's `enchants` getter, which handles both
 * the old NBT layout and 1.20.5+ item components. Reading raw NBT by hand would
 * break the moment the format changed again.
 */
const enchantsOf = (it) => {
  try {
    return it?.enchants || [];
  } catch {
    return [];
  }
};

const enchantedCount = (bot) => {
  const worn = [5, 6, 7, 8].map((i) => bot.inventory.slots[i]).filter(Boolean);
  const held = bot.inventory.items().filter((i) => /_sword$|_pickaxe$|^bow$/.test(i.name));
  return [...worn, ...held].filter((it) => enchantsOf(it).length > 0).length;
};

const hasEnchantedGear = (bot) => enchantedCount(bot) > 0;

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
    /**
     * Satisfied once she owns a pickaxe, not only while she is holding six logs.
     *
     * Requiring the logs unconditionally caused an oscillation: chop 8 logs, spend
     * them crafting tools, drop below six, and the ladder sends her back to chop
     * again — forever. A soak run never got past this pair of rungs. The logs are a
     * means to the first tools, so once the tools exist the rung is done.
     */
    done: (bot) => pickTier(bot) >= 1 || logs(bot) + Math.floor(planks(bot) / 4) >= 6,
    actions: () => [{ name: 'chopWood', args: { count: 8 } }],
  },
  {
    id: 'wood_tools',
    label: 'crafting table, pickaxe and a sword',
    /**
     * A PLACED BENCH STILL COUNTS.
     *
     * Requiring one in her pack made this rung un-do itself every single time she put a
     * bench down to craft at — observed live oscillating wood_tools -> stone ->
     * stone_tools -> wood_tools, crafting a fresh table on every lap. Owning the
     * capability is the point, not carrying the block.
     */
    done: (bot, ctx) =>
      pickTier(bot) >= 1 && swordTier(bot) >= 1 && (owns(bot, 'crafting_table') || !!ctx.memory.all.waypoints?.bench),
    actions: () => [
      { name: 'craft', args: { item: 'crafting_table', count: 1 } },
      { name: 'craft', args: { item: 'stick', count: 8 } },
      // Two, for the same reason as the stone kit: one wooden pickaxe is 59 blocks and
      // it broke mid-vein on a live run, taking the whole objective down with it.
      { name: 'craft', args: { item: 'wooden_pickaxe', count: 2 } },
      // A sword this early is what stops her punching zombies. The old rung made a
      // pickaxe and an axe and left her with no weapon at all for the first night.
      { name: 'craft', args: { item: 'wooden_sword', count: 1 } },
      { name: 'craft', args: { item: 'wooden_axe', count: 1 } },
      { name: 'equipBest', args: {} },
    ],
  },
  {
    id: 'stone',
    label: 'mine cobblestone',
    /**
     * Monotonic, like the iron rung. Requiring 22 cobble unconditionally meant the
     * stone kit — which spends 16 of them — immediately un-did this rung and sent her
     * back to mine the same stone again. Owning the kit is proof the cobble was got.
     */
    done: (bot) => count(bot, 'cobblestone') >= 22 || (pickTier(bot) >= 2 && swordTier(bot) >= 2),
    actions: () => [{ name: 'mine', args: { block: 'stone', count: 26 } }],
  },
  {
    id: 'stone_tools',
    label: 'stone kit',
    /**
     * A PLACED FURNACE STILL COUNTS — and so does the cobble to build one.
     *
     * Same trap as the crafting bench: she places the furnace to smelt, it leaves her
     * pack, and the rung un-does itself. What matters is that she CAN smelt, and eight
     * cobblestone is a furnace whenever she wants one (ensureFurnace builds it on
     * demand).
     */
    done: (bot, ctx) =>
      pickTier(bot) >= 2 &&
      swordTier(bot) >= 2 &&
      (owns(bot, 'furnace') || count(bot, 'cobblestone') >= 8 || !!ctx.memory.all.waypoints?.furnace),
    actions: () => [
      /**
       * TWO pickaxes, deliberately.
       *
       * A live run crafted exactly one, it snapped partway through a stone vein, and
       * every dig afterwards logged "a fist breaks it but drops nothing" — hundreds of
       * times, with the whole ladder dead behind it. A spare costs three cobble.
       */
      { name: 'craft', args: { item: 'stone_pickaxe', count: 2 } },
      { name: 'craft', args: { item: 'stone_sword', count: 1 } },
      { name: 'craft', args: { item: 'stone_axe', count: 1 } },
      { name: 'craft', args: { item: 'stone_shovel', count: 1 } },
      { name: 'craft', args: { item: 'furnace', count: 1 } },
      { name: 'equipBest', args: {} },
    ],
  },
  {
    id: 'food_security',
    label: 'stock food for the mining trip',
    /**
     * Raw meat counts. The old rung demanded 8 COOKED items, which needs a furnace and
     * fuel she may not have yet — and `forageFood` reported failure whenever it came
     * back with raw meat only, so a live run spent 252 seconds here and returned
     * "food: 0 cooked items" while carrying mutton. Optional so a barren area cannot
     * wall the ladder; genuine starvation is a reflex-layer emergency anyway.
     */
    optional: true,
    /**
     * A full belly plus a few spares is ready for a mining trip.
     *
     * Demanding a standing stock of 8 made this rung fight its own purpose: she cooks
     * food, eats it, drops under the bar, and forages again — the live VPS run bounced
     * food_security twice. Food is for eating; what matters is that she is not hungry and
     * has something in reserve.
     */
    done: (bot) =>
      foodCount(bot) >= 6 ||
      foodCount(bot) + rawMeatCount(bot) >= 10 ||
      (bot.food >= 14 && foodCount(bot) + rawMeatCount(bot) >= 3),
    actions: () => [
      { name: 'forageFood', args: { target: 10 } },
      { name: 'smelt', args: { item: 'cooked_beef', count: 8, any: 'meat' } },
    ],
  },
  {
    id: 'mining_kit',
    label: 'wood, sticks and spare pickaxes for the mining trip',
    /**
     * THE RUNG THAT KILLED HER.
     *
     * A live run mined the full iron budget and then lost it all. Her last stone pickaxe
     * broke at Y=11 with zero logs in the pack, so `ensurePickaxe` could not make another
     * (a pickaxe needs sticks, sticks need planks, planks need logs). With no pickaxe
     * `pickTier` fell to 0, the ladder correctly dropped back to the `wood` rung — and
     * she spent five minutes trying to chop trees fifty blocks underground until hunger
     * and mobs finished her off.
     *
     * Carrying wood underground fixes the whole chain: it is sticks for pickaxes AND
     * planks for a bench to craft them at. Four logs is five more pickaxes.
     */
    optional: true,
    done: (bot) =>
      ironSecured(bot) ||
      (logs(bot) + Math.floor(planks(bot) / 4) >= 4 && count(bot, 'stick') >= 8 && ownedCount(bot, 'stone_pickaxe') >= 2),
    actions: () => [
      { name: 'chopWood', args: { count: 8 } },
      { name: 'craft', args: { item: 'stick', count: 16, optional: true } },
      { name: 'craft', args: { item: 'stone_pickaxe', count: 3, optional: true } },
      { name: 'craft', args: { item: 'crafting_table', count: 1, optional: true } },
      // Coal picked up while mining stone turns into light for the trip down.
      { name: 'craft', args: { item: 'torch', count: 16, optional: true } },
    ],
  },
  {
    id: 'iron',
    label: `mine iron (${IRON_TARGET} ingots' worth)`,
    /**
     * Counted as a BUDGET, not as loose ingots — see ironBudget. This is what stops the
     * rung un-doing itself as soon as smelting and crafting spend the ore.
     */
    /**
     * Either she has mined the iron, or she is already standing there in gear that is
     * iron-tier or better — someone handed her diamond, or she looted it. Requiring the
     * ingots unconditionally would send a fully diamond-equipped bot back down the mine.
     */
    done: ironSecured,
    /**
     * Kit up BEFORE descending. A branch-mining trip outlasts several stone pickaxes,
     * and replacing one at Y=16 needs a bench and sticks in her pack — without them the
     * trip ended early with "pickaxe dying" and the retry had no pickaxe at all.
     */
    actions: (bot, ctx) => [
      { name: 'craft', args: { item: 'stone_pickaxe', count: 3, optional: true } },
      { name: 'craft', args: { item: 'stick', count: 8, optional: true } },
      { name: 'craft', args: { item: 'crafting_table', count: 1, optional: true } },
      { name: 'branchMine', args: { targetY: ctx.config.ironY, ore: 'iron_ore', count: IRON_TARGET + 3 } },
    ],
  },
  {
    id: 'iron_kit',
    label: 'full iron armour, pickaxe, sword, shield',
    /**
     * The acceptance criteria, expressed exactly: four iron pieces actually WORN, an
     * iron pickaxe, an iron sword, and a shield she owns (the shield lives in the
     * off-hand, which `items()` does not report — hence `owns`).
     */
    done: (bot) => wearingFullIron(bot) && pickTier(bot) >= 3 && swordTier(bot) >= 3 && owns(bot, 'shield'),
    actions: () => [
      // Come up and do the smelting and crafting at camp, in daylight, rather than
      // standing at Y=11 in the dark with no armour on while a furnace burns.
      { name: 'home', args: {} },
      { name: 'smelt', args: { item: 'iron_ingot', count: IRON_TARGET } },
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
    id: 'torches',
    label: 'coal and torches',
    /**
     * `|| count(coal) === 0` made this rung true the instant she spawned, so she was
     * sent down to mine iron with no light at all — which is how most of the deaths
     * happened. Now it is a real objective, but an optional one: no coal on the surface
     * is normal, and branch mining picks coal up on the way down regardless.
     */
    optional: true,
    /**
     * Torches are for PLACING. Gating on 16 held meant she made 16, put one down while
     * sheltering, dropped to 15 and was sent back to chop more wood for sticks — the
     * live run bounced torches -> shelter -> torches. Eight in the pack is plenty to
     * start a mining trip, and a stack of coal means she can always make more.
     */
    done: (bot) => ownedCount(bot, 'torch') >= 8 || (count(bot, 'coal') >= 6 && count(bot, 'stick') >= 4),
    /**
     * A torch is coal AND a stick. She reached this rung holding 27 coal and zero logs,
     * so every craft failed on "need 1x stick" — the wood has to be part of the rung.
     */
    actions: (bot) => [
      ...(logs(bot) + Math.floor(planks(bot) / 4) < 2 ? [{ name: 'chopWood', args: { count: 6 } }] : []),
      { name: 'mine', args: { block: 'coal_ore', count: 6, optional: true } },
      { name: 'craft', args: { item: 'stick', count: 8, optional: true } },
      { name: 'craft', args: { item: 'torch', count: 16, optional: true } },
    ],
  },
  {
    id: 'shelter',
    label: 'a safe place to log off',
    done: (bot, ctx) => !!ctx.memory.all.bed || !!ctx.memory.all.shelterBuilt,
    actions: () => [{ name: 'shelter', args: {} }],
  },
  {
    id: 'bed',
    label: 'wool, a bed, and a way to skip the night',
    /**
     * A real rung of its own. The old version tacked an optional bed craft onto the
     * shelter rung, which never fired because 3 wool is not something she happens to
     * be carrying — so she spent every night awake being shot at. Sheep first, then
     * the bed, then actually sleep in it.
     */
    /**
     * Optional. A biome with no sheep made this unsatisfiable, and because it sits
     * before the iron rung it walled the entire ladder off — she retried getWool
     * forever and never mined a single ore. A bed is a comfort, not a prerequisite.
     */
    optional: true,
    done: (bot, ctx) => !!ctx.memory.all.bed || countAny(bot, ...BED_NAMES) > 0 || owns(bot, 'white_bed'),
    actions: () => [
      { name: 'getWool', args: { count: 3 } },
      { name: 'craft', args: { item: 'white_bed', count: 1, optional: true } },
      { name: 'placeBed', args: {} },
    ],
  },
  {
    id: 'water_bucket',
    label: 'water bucket for lava and MLG saves',
    // Optional: there is not always open water in reach, and she must not stall on it
    // now that it sits directly after the iron kit.
    optional: true,
    done: (bot) => owns(bot, 'water_bucket'),
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

  // ── endgame ────────────────────────────────────────────────
  // Enchanting is the biggest remaining power jump: Protection IV across four
  // pieces roughly halves incoming damage, and Sharpness V adds about three
  // hearts a swing. No combat tuning competes with that.
  {
    id: 'obsidian',
    label: 'obsidian for a table',
    done: (bot) => has(bot, 'obsidian', 4) || has(bot, 'enchanting_table') || hasEnchantedGear(bot),
    actions: () => [{ name: 'getObsidian', args: { count: 10 } }],
  },
  {
    id: 'books',
    label: 'paper and leather into books',
    done: (bot) => countAny(bot, 'book', 'bookshelf') >= 15 || hasEnchantedGear(bot),
    actions: () => [{ name: 'makeBooks', args: { count: 15 } }],
  },
  {
    id: 'enchant_setup',
    label: 'enchanting table ringed with bookshelves',
    done: (bot, ctx) => !!ctx.memory.all.waypoints?.enchanting || hasEnchantedGear(bot),
    actions: () => [{ name: 'bookshelves', args: { count: 15 } }],
  },
  {
    id: 'xp',
    label: 'level 30',
    done: (bot) => (bot.experience?.level ?? 0) >= 30 || hasEnchantedGear(bot),
    actions: () => [{ name: 'xpGrind', args: { level: 30 } }],
  },
  {
    id: 'enchanted_kit',
    label: 'enchanted sword, armour and pickaxe',
    done: (bot) => enchantedCount(bot) >= 4,
    actions: () => [{ name: 'enchantKit', args: { minLevel: 30 } }, { name: 'equipBest', args: {} }],
  },
  {
    id: 'gapples',
    label: 'a golden apple in the pocket',
    // Optional: gold is not always nearby, so she must not stall here forever.
    done: (bot) => has(bot, 'golden_apple') || has(bot, 'enchanted_golden_apple') || countAny(bot, 'gold_ingot') < 8,
    actions: () => [
      { name: 'mine', args: { block: 'gold_ore', count: 8, optional: true } },
      { name: 'smelt', args: { item: 'gold_ingot', count: 8 } },
      { name: 'craft', args: { item: 'golden_apple', count: 1, optional: true } },
    ],
  },
  {
    id: 'netherite_ingots',
    label: 'a nether trip for ancient debris',
    /**
     * Deliberately optional. Netherite *gear* needs a smithing template that only
     * generates in bastion loot, which is out of reach for an unattended bot, so
     * this rung is satisfied either by getting ingots or by simply not having the
     * diamond pickaxe required to try. She never blocks the ladder on it.
     */
    done: (bot) => has(bot, 'netherite_ingot') || !has(bot, 'diamond_pickaxe') || enchantedCount(bot) < 4,
    actions: () => [
      { name: 'netherRun', args: { debris: 4 } },
      { name: 'netheriteIngot', args: { count: 1 } },
      { name: 'home', args: {} },
      { name: 'deposit', args: { keep: 'gear,food,torch,blocks' } },
    ],
  },
  {
    id: 'netherite_gear',
    label: 'upgrade gear to netherite',
    /**
     * Only reachable with an upgrade template, which is bastion loot. If she has one
     * she will use it — the smithing path is verified working end to end — and if she
     * does not, this rung is already satisfied so it never becomes a wall.
     */
    done: (bot) =>
      !has(bot, 'netherite_upgrade_smithing_template') ||
      !has(bot, 'netherite_ingot') ||
      countAny(bot, 'netherite_sword', 'netherite_chestplate', 'netherite_pickaxe') > 0,
    actions: () => [
      { name: 'upgradeNetherite', args: { item: 'diamond_sword' } },
      { name: 'upgradeNetherite', args: { item: 'diamond_chestplate' } },
      { name: 'equipBest', args: {} },
    ],
  },
];

/** Has this rung been parked as impossible in this world for now? */
const isSkipped = (ctx, id) => {
  const until = ctx?.skip?.get?.(id);
  return !!until && Date.now() < until;
};

/** First unmet rung. Null means she has finished the whole ladder. */
export function currentRung(bot, ctx) {
  for (const rung of LADDER) {
    if (isSkipped(ctx, rung.id)) continue;
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
    return { id: r.id, label: r.label, done, skipped: isSkipped(ctx, r.id) };
  });
  const doneCount = rows.filter((r) => r.done).length;
  return { rows, doneCount, total: rows.length, current: currentRung(bot, ctx)?.id ?? 'complete' };
}

export const ladderStatus = {
  count,
  countAny,
  has,
  owns,
  ownedCount,
  ironBudget,
  wearingFullIron,
  IRON_FOR_KIT,
  IRON_TARGET,
  enchantedCount,
  hasEnchantedGear,
  logs,
  planks,
  pickTier,
  swordTier,
  armorPieces,
  armorTier,
  foodCount,
  rawMeatCount,
};
