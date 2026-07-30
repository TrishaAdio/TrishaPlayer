/**
 * Auto-gear. Runs on inventory change, on spawn, before every fight.
 * She is never caught holding a pickaxe in a swordfight.
 */
import { log } from '../util/log.js';

const MATERIAL_RANK = { netherite: 6, diamond: 5, iron: 4, chainmail: 3, stone: 3, golden: 2, gold: 2, leather: 1, wooden: 1, wood: 1 };

const rankOf = (name = '') => {
  for (const [mat, r] of Object.entries(MATERIAL_RANK)) if (name.includes(mat)) return r;
  return 0;
};

const ARMOR_SLOTS = [
  { dest: 'head', suffix: '_helmet', slot: 5, extra: ['turtle_helmet'] },
  { dest: 'torso', suffix: '_chestplate', slot: 6, extra: ['elytra'] },
  { dest: 'legs', suffix: '_leggings', slot: 7, extra: [] },
  { dest: 'feet', suffix: '_boots', slot: 8, extra: [] },
];

/**
 * Weapon preference, best damage first.
 *
 * The tail matters: observed live, she was "killing mobs with hands" early game,
 * because before her first sword the list ran out and she punched. A wooden pickaxe
 * does more damage than a fist and a shovel does more than nothing, so tools are
 * included as a last resort. Fists are never the answer while she is holding metal.
 */
const WEAPON_ORDER = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'netherite_axe', 'diamond_axe',
  'stone_sword', 'iron_axe', 'golden_sword', 'stone_axe', 'wooden_sword', 'wooden_axe',
  // last-resort improvised weapons, in damage order
  'netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe',
  'netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'wooden_shovel',
];

/**
 * Axes, best first. Kept separate from WEAPON_ORDER because the axe is a tactical
 * choice, not a fallback: it hits harder per swing and, crucially, disables a
 * shield for five seconds. Against anyone who blocks, that is the opener.
 */
const AXE_WEAPON_ORDER = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'];
const PICK_ORDER = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'];
const AXE_ORDER = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'];
const SHOVEL_ORDER = ['netherite_shovel', 'diamond_shovel', 'iron_shovel', 'stone_shovel', 'golden_shovel', 'wooden_shovel'];

const findFirst = (bot, order) => {
  for (const name of order) {
    const it = bot.inventory.items().find((i) => i.name === name);
    if (it) return it;
  }
  return null;
};

export const bestWeapon = (bot) => findFirst(bot, WEAPON_ORDER);
export const bestAxeWeapon = (bot) => findFirst(bot, AXE_WEAPON_ORDER);
export const bestSword = (bot) => findFirst(bot, ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword']);

/** Swap the held weapon without disturbing armour or the off-hand. */
export async function equipNamed(bot, item) {
  if (!item) return false;
  if (bot.heldItem?.name === item.name) return true;
  try {
    await bot.equip(item, 'hand');
    return true;
  } catch {
    return false;
  }
}
export const bestPickaxe = (bot) => findFirst(bot, PICK_ORDER);
export const bestAxe = (bot) => findFirst(bot, AXE_ORDER);
export const bestShovel = (bot) => findFirst(bot, SHOVEL_ORDER);

/** Tool appropriate for the block, so she never punches stone with her fist. */
export function toolFor(bot, block) {
  if (!block) return bestPickaxe(bot) || bestWeapon(bot);
  const n = block.name;
  if (/log|planks|wood|fence|door|chest|crafting_table|bamboo/.test(n)) return bestAxe(bot) || bestPickaxe(bot);
  if (/dirt|sand|gravel|clay|soul_sand|snow|podzol|mycelium|grass_block|farmland|mud/.test(n)) return bestShovel(bot) || bestPickaxe(bot);
  if (/leaves|wool|web/.test(n)) return findFirst(bot, ['netherite_sword', 'diamond_sword', 'iron_sword', 'shears']) || bestAxe(bot);
  return bestPickaxe(bot);
}

async function equipIfBetter(bot, item, dest, currentSlot) {
  if (!item) return false;
  const current = bot.inventory.slots[currentSlot];
  if (current && current.name === item.name) return false;
  if (current && rankOf(current.name) >= rankOf(item.name)) return false;
  try {
    await bot.equip(item, dest);
    return true;
  } catch (err) {
    log.debug(`equip ${item.name} -> ${dest} failed: ${err.message}`);
    return false;
  }
}

/** Wear the best armour she owns. */
export async function equipBestArmor(bot) {
  let changed = 0;
  for (const s of ARMOR_SLOTS) {
    const candidates = bot.inventory
      .items()
      .filter((i) => i.name.endsWith(s.suffix) || s.extra.includes(i.name))
      .sort((a, b) => rankOf(b.name) - rankOf(a.name));
    if (await equipIfBetter(bot, candidates[0], s.dest, s.slot)) changed++;
  }
  return changed;
}

/** Shield in the off-hand — the single biggest survivability item in the game. */
export async function equipShield(bot) {
  const shield = bot.inventory.items().find((i) => i.name === 'shield');
  if (!shield) return false;
  if (bot.inventory.slots[45]?.name === 'shield') return false;
  // Never evict a totem that is protecting her right now.
  if (bot.inventory.slots[45]?.name === 'totem_of_undying' && bot.health <= 8) return false;
  try {
    await bot.equip(shield, 'off-hand');
    return true;
  } catch {
    return false;
  }
}

export async function equipWeapon(bot) {
  const w = bestWeapon(bot);
  if (!w) return false;
  if (bot.heldItem?.name === w.name) return false;
  try {
    await bot.equip(w, 'hand');
    return true;
  } catch {
    return false;
  }
}

export async function equipTool(bot, block) {
  const t = toolFor(bot, block);
  if (!t) return false;
  if (bot.heldItem?.name === t.name) return true;
  try {
    await bot.equip(t, 'hand');
    return true;
  } catch {
    return false;
  }
}

/** Full pass: armour + shield + weapon. */
export async function equipBest(bot) {
  const armor = await equipBestArmor(bot);
  const shield = await equipShield(bot);
  const weapon = await equipWeapon(bot);
  if (armor || shield || weapon) log.reflex(`geared up (${armor} armour, shield ${shield}, weapon ${weapon})`);
  return { armor, shield, weapon };
}

/** Is this tool one hit from snapping? Time to go home. */
export function toolNearlyBroken(bot, item = bot.heldItem) {
  if (!item || item.maxDurability == null) return false;
  const used = item.durabilityUsed ?? 0;
  return item.maxDurability - used <= 12;
}

/**
 * KEEP A WEAPON IN HAND WHEN SOMETHING IS CLOSE.
 *
 * Reported directly: "its just not holding sword". Mining leaves a pickaxe in her
 * hand, and if a mob wanders up she would meet it holding a mining tool. This runs
 * on the reflex tick, so the swap happens before the fight rather than during it.
 */
export async function weaponReadyCheck(bot, hostileWithin = 12) {
  const weapon = bestWeapon(bot);
  if (!weapon) return false;

  const held = bot.heldItem?.name;
  const holdingWeapon = /_sword$|_axe$/.test(held || '');
  if (holdingWeapon) return false;

  const me = bot.entity?.position;
  if (!me) return false;
  const threat = Object.values(bot.entities).some((e) => {
    if (!e?.position || e === bot.entity) return false;
    if (e.type !== 'mob' && e.type !== 'player') return false;
    if (e.type === 'player' && e.username === bot.username) return false;
    return me.distanceTo(e.position) <= hostileWithin;
  });
  if (!threat) return false;

  /**
   * Never take a tool out of her hand while she is mining.
   *
   * targetDigBlock alone was not enough: the swap slipped into the window between
   * equipping the pickaxe and the dig actually starting, which made the harvest check
   * reject the block. The mining lock covers that whole window.
   */
  if (bot.targetDigBlock || bot._miningNow) return false;

  try {
    await bot.equip(weapon, 'hand');
    return true;
  } catch {
    return false;
  }
}

export function installGear(bot) {
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(async () => {
      queued = false;
      if (!bot.entity) return;
      try {
        await equipBestArmor(bot);
        await equipShield(bot);
      } catch {}
    }, 900);
  };
  bot.on('playerCollect', (collector) => {
    if (collector?.username === bot.username) schedule();
  });
  bot.on('spawn', schedule);
}
