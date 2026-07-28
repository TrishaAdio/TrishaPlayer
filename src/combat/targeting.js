/**
 * Who to hit, and how badly it wants to hurt her (or RAREAURA).
 */
import { config } from '../config.js';
import { nearbyEntities, HOSTILES } from '../world/scan.js';

/** Mobs that must die immediately regardless of distance. */
const PRIORITY = {
  creeper: 100,
  warden: 95,
  witch: 80,
  evoker: 78,
  ravager: 76,
  vindicator: 70,
  pillager: 66,
  blaze: 64,
  skeleton: 60,
  stray: 60,
  bogged: 60,
  wither_skeleton: 58,
  piglin_brute: 56,
  enderman: 40,
  spider: 34,
  cave_spider: 36,
  zombie: 30,
  husk: 30,
  drowned: 32,
  slime: 20,
  magma_cube: 24,
  silverfish: 18,
  phantom: 42,
  breeze: 50,
  creaking: 44,
};

/** Things she should never pick a fight with unprovoked. */
const LEAVE_ALONE = new Set(['enderman', 'iron_golem', 'piglin', 'zombified_piglin', 'wolf', 'llama', 'panda', 'polar_bear', 'goat', 'bee', 'villager', 'wandering_trader', 'cat', 'ocelot', 'horse', 'donkey', 'axolotl', 'allay', 'armadillo', 'sniffer', 'camel', 'frog']);

export class Targeting {
  constructor(bot) {
    this.bot = bot;
    this.provoked = new Map(); // entityId -> timestamp of when it hit us
    this.ownerAttackers = new Map();
    this.manualTarget = null;
    this.install();
  }

  install() {
    const bot = this.bot;
    bot.on('entityHurt', (entity) => {
      // Something hurt her -> it is now fair game even if normally neutral.
      if (entity === bot.entity) {
        const attacker = this.guessAttacker();
        if (attacker) this.provoked.set(attacker.id, Date.now());
      }
      const owner = bot.players[config.owner]?.entity;
      if (owner && entity === owner) {
        const attacker = this.guessAttacker(owner);
        if (attacker) this.ownerAttackers.set(attacker.id, Date.now());
      }
    });
  }

  /** Nearest plausible aggressor — mineflayer does not tell us who swung. */
  guessAttacker(victim = this.bot.entity) {
    const ents = nearbyEntities(this.bot, 6);
    const candidates = ents.filter((e) => e.entity !== victim && (e.isHostile || e.isPlayer));
    if (!candidates.length) return null;
    let best = null;
    let bestD = Infinity;
    for (const c of candidates) {
      const d = victim.position.distanceTo(c.entity.position);
      if (d < bestD) {
        bestD = d;
        best = c.entity;
      }
    }
    return best;
  }

  isProvoked(entity) {
    const t = this.provoked.get(entity.id);
    return t && Date.now() - t < 30000;
  }

  isOwnerAttacker(entity) {
    const t = this.ownerAttackers.get(entity.id);
    return t && Date.now() - t < 30000;
  }

  /** Score every candidate; highest wins. */
  score(e) {
    const bot = this.bot;
    let s = PRIORITY[e.name] ?? (e.isHostile ? 25 : 0);

    if (e.isPlayer) {
      const name = e.username;
      if (name === config.owner) return -1000; // never
      if (config.friends.includes(name)) return -1000;
      const hostileToOwner = this.isOwnerAttacker(e.entity);
      const hostileToMe = this.isProvoked(e.entity);
      if (hostileToOwner) s = 200; // top of the list, nothing outranks this
      else if (hostileToMe) s = 120;
      else if (config.combat.pvpMode === 'free') s = 45;
      else return -1000; // self_defence: leave players alone
    } else {
      if (LEAVE_ALONE.has(e.name) && !this.isProvoked(e.entity) && !this.isOwnerAttacker(e.entity)) return -1000;
      if (!HOSTILES.has(e.name) && !this.isProvoked(e.entity)) return -1000;
      if (this.isOwnerAttacker(e.entity)) s += 90;
    }

    // Closer is more urgent, but priority dominates.
    s += Math.max(0, 24 - e.distance) * 1.5;
    // Nearly dead things get finished off.
    if (e.health != null && e.health <= 6) s += 12;
    // Things that cannot reach her matter less.
    if (e.distance > 16 && !e.isPlayer) s -= 20;
    return s;
  }

  /** Best current target, or null if nothing is worth swinging at. */
  pick({ maxDistance = 18 } = {}) {
    if (this.manualTarget) {
      const e = this.bot.entities[this.manualTarget.id];
      if (e && e.isValid !== false) return e;
      this.manualTarget = null;
    }
    const ents = nearbyEntities(this.bot, maxDistance);
    let best = null;
    let bestScore = 0;
    for (const e of ents) {
      const s = this.score(e);
      if (s > bestScore) {
        bestScore = s;
        best = e.entity;
      }
    }
    return best;
  }

  setManual(entity) {
    this.manualTarget = entity;
  }

  clearManual() {
    this.manualTarget = null;
  }

  /** Resolve "that zombie" / "RAREAURA's target" / a username into an entity. */
  resolve(text) {
    const bot = this.bot;
    const q = String(text || '').toLowerCase().trim();
    if (!q) return null;

    const players = Object.values(bot.players)
      .filter((p) => p.entity && p.username !== bot.username)
      .map((p) => p.entity);
    const byName = players.find((e) => e.username?.toLowerCase() === q);
    if (byName) return byName;

    const ents = nearbyEntities(bot, 40);
    const exact = ents.find((e) => e.name?.toLowerCase() === q || e.username?.toLowerCase() === q);
    if (exact) return exact.entity;
    const partial = ents.find((e) => e.name?.toLowerCase().includes(q));
    if (partial) return partial.entity;

    if (/nearest|closest|any|it|that|them/.test(q)) return this.pick();
    return null;
  }
}
