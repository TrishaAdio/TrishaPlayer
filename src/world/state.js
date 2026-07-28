import { config } from '../config.js';
import { mem } from './memory.js';
import { nearbyEntities, timeLabel, lightHere, groundBelow, standingDanger } from './scan.js';

const r = (n) => Math.round(n);

/** Inventory folded into "name xCount" strings, biggest stacks first. */
export function inventorySummary(bot, limit = 22) {
  const counts = new Map();
  for (const it of bot.inventory.items()) {
    counts.set(it.name, (counts.get(it.name) || 0) + it.count);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([n, c]) => `${n} x${c}`);
}

export function armorSummary(bot) {
  const slots = { head: 5, torso: 6, legs: 7, feet: 8 };
  const worn = {};
  for (const [k, i] of Object.entries(slots)) {
    const it = bot.inventory.slots[i];
    worn[k] = it ? it.name : null;
  }
  const n = Object.values(worn).filter(Boolean).length;
  return { worn, pieces: n, label: n === 0 ? 'none' : `${n}/4: ${Object.values(worn).filter(Boolean).join(', ')}` };
}

/**
 * The snapshot handed to the brain. Deliberately compact — every token here is
 * paid for on every single decision, so it carries only what changes behaviour.
 */
export function snapshot(bot, extra = {}) {
  const pos = bot.entity.position;
  const ents = nearbyEntities(bot, 26);
  const hostiles = ents.filter((e) => e.isHostile);
  const players = ents.filter((e) => e.isPlayer);
  const owner = bot.players[config.owner]?.entity;
  const ground = groundBelow(bot);

  return {
    me: {
      health: r(bot.health),
      food: r(bot.food),
      pos: { x: r(pos.x), y: r(pos.y), z: r(pos.z) },
      dimension: bot.game?.dimension || 'overworld',
      onGround: bot.entity.onGround,
      inWater: bot.entity.isInWater ?? false,
      oxygen: bot.oxygenLevel,
      xpLevel: bot.experience?.level ?? 0,
      standingDanger: standingDanger(bot),
      dropBelow: ground.found ? ground.drop : `>${ground.drop}`,
    },
    world: {
      time: timeLabel(bot),
      raining: !!bot.isRaining,
      light: lightHere(bot),
      biome: bot.blockAt(pos.floored())?.biome?.name || 'unknown',
    },
    gear: {
      hand: bot.heldItem?.name || 'empty',
      offhand: bot.inventory.slots[45]?.name || 'empty',
      armor: armorSummary(bot).label,
    },
    inventory: inventorySummary(bot),
    threats: hostiles.slice(0, 6).map((h) => ({ name: h.name, dist: h.distance })),
    players: players.map((p) => ({
      name: p.username,
      dist: p.distance,
      isOwner: p.username === config.owner,
      isFriend: config.friends.includes(p.username),
    })),
    owner: owner
      ? { online: true, dist: +pos.distanceTo(owner.position).toFixed(1), y: r(owner.position.y) }
      : { online: !!bot.players[config.owner], dist: null },
    memory: mem.summary(),
    ...extra,
  };
}

/** Human-readable form — cheaper in tokens than JSON and models read it fine. */
export function snapshotText(bot, extra = {}) {
  const s = snapshot(bot, extra);
  const L = [];
  L.push(`HP ${s.me.health}/20  Food ${s.me.food}/20  XP ${s.me.xpLevel}  at ${s.me.pos.x},${s.me.pos.y},${s.me.pos.z} (${s.me.dimension})`);
  L.push(`${s.world.time}, ${s.world.raining ? 'raining' : 'clear'}, light ${s.world.light}, ${s.world.biome}`);
  if (s.me.standingDanger) L.push(`!! STANDING IN DANGER: ${s.me.standingDanger}`);
  if (s.me.inWater) L.push(`in water, oxygen ${s.me.oxygen}`);
  L.push(`hand: ${s.gear.hand} | offhand: ${s.gear.offhand} | armor: ${s.gear.armor}`);
  L.push(`inventory: ${s.inventory.length ? s.inventory.join(', ') : 'EMPTY'}`);
  L.push(s.threats.length ? `hostiles: ${s.threats.map((t) => `${t.name}@${t.dist}m`).join(', ')}` : 'hostiles: none');
  if (s.players.length) {
    L.push(`players: ${s.players.map((p) => `${p.name}@${p.dist}m${p.isOwner ? ' (OWNER)' : p.isFriend ? ' (friend)' : ''}`).join(', ')}`);
  }
  L.push(
    s.owner.online
      ? `owner ${config.owner}: online${s.owner.dist != null ? `, ${s.owner.dist}m away` : ', out of range'}`
      : `owner ${config.owner}: offline`,
  );
  if (s.memory) L.push(`--- memory ---\n${s.memory}`);
  for (const [k, v] of Object.entries(extra)) {
    if (v != null && v !== '') L.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return L.join('\n');
}
