import { Vec3 } from 'vec3';

export const HOSTILES = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'wither_skeleton',
  'creeper', 'spider', 'cave_spider', 'enderman', 'witch', 'pillager', 'vindicator', 'evoker',
  'ravager', 'vex', 'illusioner', 'blaze', 'ghast', 'magma_cube', 'slime', 'hoglin', 'zoglin',
  'piglin_brute', 'phantom', 'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite',
  'warden', 'breeze', 'creaking',
]);

/** Mobs that are only a threat if provoked — she leaves them alone. */
export const NEUTRAL = new Set(['piglin', 'enderman', 'zombified_piglin', 'bee', 'llama', 'panda', 'polar_bear', 'goat', 'wolf', 'iron_golem', 'dolphin']);

export const FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom']);

export const DANGER_BLOCKS = new Set(['lava', 'flowing_lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose', 'cactus', 'powder_snow', 'pointed_dripstone']);

const NEIGHBOURS = [
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 1, 0), new Vec3(0, -1, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1),
];

/** Everything alive nearby, sorted by distance, tagged by threat. */
export function nearbyEntities(bot, maxDistance = 24) {
  const me = bot.entity?.position;
  if (!me) return [];
  const out = [];
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position) continue;
    if (e.type === 'object' || e.type === 'orb' || e.type === 'projectile') continue;
    const d = me.distanceTo(e.position);
    if (d > maxDistance) continue;
    const name = e.name || e.displayName || e.kind || 'unknown';
    out.push({
      entity: e,
      name,
      username: e.username || null,
      distance: +d.toFixed(1),
      isPlayer: e.type === 'player',
      isHostile: HOSTILES.has(name),
      isFood: FOOD_ANIMALS.has(name),
      health: e.health,
    });
  }
  return out.sort((a, b) => a.distance - b.distance);
}

export function hostilesNear(bot, maxDistance = 16) {
  return nearbyEntities(bot, maxDistance).filter((e) => e.isHostile);
}

export function playersNear(bot, maxDistance = 32) {
  return nearbyEntities(bot, maxDistance).filter((e) => e.isPlayer);
}

/**
 * SAFETY: never break a block with lava or water pressing against it.
 * Checks all six neighbours plus the block above (falling gravel/sand).
 */
export function isSafeToDig(bot, block) {
  if (!block) return false;
  for (const off of NEIGHBOURS) {
    const n = bot.blockAt(block.position.plus(off));
    if (!n) continue;
    if (/lava/.test(n.name)) return false;
    if (/water/.test(n.name) && block.position.y < bot.entity.position.y) return false;
  }
  const above = bot.blockAt(block.position.offset(0, 1, 0));
  if (above && /lava|water/.test(above.name)) return false;
  return true;
}

/** Is the bot standing somewhere that will kill it if it stays? */
export function standingDanger(bot) {
  const p = bot.entity.position;
  const feet = bot.blockAt(p.floored());
  const legs = bot.blockAt(p.offset(0, 1, 0));
  const under = bot.blockAt(p.offset(0, -1, 0));
  if (feet && /lava/.test(feet.name)) return 'lava';
  if (legs && /lava/.test(legs.name)) return 'lava';
  if (feet && /fire/.test(feet.name)) return 'fire';
  if (under && /magma_block/.test(under.name)) return 'magma';
  if (feet && /powder_snow/.test(feet.name)) return 'powder_snow';
  /**
   * Drowning requires actually being in water.
   *
   * Without the isInWater guard this fired continuously on dry land, because some
   * servers leave bot.oxygenLevel at 0 when they never send an air update. The
   * consequence was severe and non-obvious: the reflex layer "rescued" her from
   * imaginary drowning several times a second, and each rescue called
   * pathfinder.setGoal — which cancelled whatever path a skill was walking, so
   * "come here" and "follow me" died instantly with "goal was changed".
   */
  const submerged = bot.entity?.isInWater || /water/.test(legs?.name || '') || /water/.test(feet?.name || '');
  /**
   * React at 16 air, not 10.
   *
   * She drowned repeatedly in open water. By the time the bar is at 10 she may be
   * dozens of blocks from shore, and a long swim back costs more air than she has
   * left. Reacting early is the entire difference between a wet bot and a dead one.
   */
  if (submerged && bot.oxygenLevel !== undefined && bot.oxygenLevel < 16) return 'drowning';
  return null;
}

/** Solid ground beneath, or is she over a hole / lava lake? */
export function groundBelow(bot, maxDrop = 24) {
  const p = bot.entity.position.floored();
  for (let dy = 1; dy <= maxDrop; dy++) {
    const b = bot.blockAt(p.offset(0, -dy, 0));
    if (!b) return { found: false, drop: dy, block: null };
    if (b.boundingBox === 'block') return { found: true, drop: dy, block: b, lethal: /lava/.test(b.name) };
    if (/lava/.test(b.name)) return { found: true, drop: dy, block: b, lethal: true };
    if (/water/.test(b.name)) return { found: true, drop: dy, block: b, lethal: false, water: true };
  }
  return { found: false, drop: maxDrop, block: null };
}

export function findBlocks(bot, names, { maxDistance = 48, count = 16 } = {}) {
  const mcData = bot.mcData;
  const ids = [];
  for (const n of [].concat(names)) {
    const b = mcData.blocksByName[n];
    if (b) ids.push(b.id);
  }
  if (!ids.length) return [];
  return bot.findBlocks({ matching: ids, maxDistance, count });
}

/** Light level where she's standing — low light means mobs will spawn. */
export function lightHere(bot) {
  const b = bot.blockAt(bot.entity.position.floored());
  return b?.light ?? b?.skyLight ?? 15;
}

export function isNight(bot) {
  const t = bot.time?.timeOfDay ?? 0;
  return t > 13000 && t < 23000;
}

export function timeLabel(bot) {
  const t = bot.time?.timeOfDay ?? 0;
  if (t < 6000) return 'morning';
  if (t < 12000) return 'day';
  if (t < 13800) return 'sunset';
  if (t < 22000) return 'night';
  return 'sunrise';
}
