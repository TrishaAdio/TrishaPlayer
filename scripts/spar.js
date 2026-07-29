/**
 * SPARRING HARNESS — self-play PvP.
 *
 * Puts two bots on a real server with identical gear in a flat, walled arena and
 * makes them fight to the death. Both run the genuine stack: reflexes, clutches,
 * auto-gear and the full combat engine. The only difference between them is their
 * combat parameter profile.
 *
 * This is what turns "I think 3.4 blocks is the right engage range" into a number
 * with evidence behind it.
 *
 * Requires the server's console FIFO so it can build the arena, clear inventories,
 * hand out identical kits and teleport the fighters between rounds.
 *
 * Usage:
 *   SPAR_FIFO=/path/to/stdin.fifo node scripts/spar.js --duels 4 --a '{"engageRange":3.1}'
 *
 * Prints a JSON result block on the last line so the tuner can parse it.
 */
import fs from 'node:fs';
import mineflayer from 'mineflayer';
import mcDataLoader from 'minecraft-data';
import { Reflex } from '../src/reflex/survival.js';
import { installGear, equipBest } from '../src/reflex/gear.js';
import { installMovement } from '../src/skills/move.js';
import { Targeting } from '../src/combat/targeting.js';
import { CombatEngine } from '../src/combat/engine.js';
import { DEFAULT_PARAMS } from '../src/combat/params.js';
import { ARCHETYPES } from './archetypes.js';

// ── args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION || '1.21.4';
const FIFO = process.env.SPAR_FIFO || '';
const DUELS = Number(arg('duels', 3));
const ROUND_TIMEOUT_MS = Number(arg('timeout', 75)) * 1000;
const QUIET = argv.includes('--quiet');

const A_NAME = arg('aname', 'Challenger');
const B_NAME = arg('bname', 'Baseline');

// Declared up here because the parameter blocks below depend on it.
const ARCHETYPE = arg('archetype', '');
const ARCH = ARCHETYPE && ARCHETYPES[ARCHETYPE] ? ARCHETYPES[ARCHETYPE] : null;
if (ARCHETYPE && !ARCH) {
  console.error(`unknown archetype "${ARCHETYPE}". known: ${Object.keys(ARCHETYPES).join(', ')}`);
  process.exit(1);
}

/**
 * Fight to the death, applied equally to both sides.
 *
 * With the normal break-off threshold in place, half of all rounds ended 4 HP vs
 * 4 HP: both fighters disengage at low health, cannot heal with regeneration off,
 * and circle each other until the clock runs out. Those draws measured nothing and
 * consumed half the sample budget.
 *
 * Disabling break-off is fair because it applies to both profiles identically, and
 * it isolates what is actually being tuned — spacing, timing and swing rate —
 * rather than retreat behaviour, which is a survival feature tested elsewhere.
 */
const TO_DEATH = !argv.includes('--no-death-match');
const DEATH_PATCH = TO_DEATH ? { breakOffHp: 0 } : {};

const A_PARAMS = { ...JSON.parse(arg('a', '{}')), ...DEATH_PATCH };
// An archetype, if named, defines the opponent entirely.
const B_PARAMS = ARCH
  ? { ...ARCH.params, ...DEATH_PATCH }
  : { ...JSON.parse(arg('b', '{}')), ...DEATH_PATCH };

// ── arena ───────────────────────────────────────────────────────────
// A fixed, force-loaded, flat stone platform. Identical every round, so terrain
// never becomes a hidden variable in the results.
const ARENA = { x: 200, y: 70, z: 200, half: 16 };
const A_SPAWN = { x: ARENA.x - 5, y: ARENA.y, z: ARENA.z };
const B_SPAWN = { x: ARENA.x + 5, y: ARENA.y, z: ARENA.z };

/**
 * No food in the kit and natural regeneration off, deliberately. With regen on,
 * two competent fighters heal faster than they can finish each other and every
 * round ends in a 45-second stalemate — which measures nothing. Turning it off
 * makes each duel a clean test of damage traded per second, so win rate becomes
 * a real signal.
 */
const KIT = [
  'iron_sword 1', 'shield 1', 'iron_helmet 1', 'iron_chestplate 1',
  'iron_leggings 1', 'iron_boots 1',
];

// An archetype opponent brings its own loadout, so a bow kiter actually has a bow.
const A_KIT = arg('akit', '') ? arg('akit', '').split('|') : KIT;
const B_KIT = ARCH ? ARCH.kit : (arg('bkit', '') ? arg('bkit', '').split('|') : KIT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => {
  if (!QUIET) console.log(...a);
};

function cmd(line) {
  if (!FIFO) return;
  try {
    fs.writeFileSync(FIFO, `${line}\n`);
  } catch (err) {
    console.error(`console write failed: ${err.message}`);
  }
}

function buildArena() {
  cmd('difficulty peaceful'); // no wandering mobs deciding the duel for us
  cmd('gamerule doDaylightCycle false');
  cmd('gamerule keepInventory true');
  cmd('gamerule naturalRegeneration false');
  cmd('gamerule sendCommandFeedback false');
  cmd('time set day');
  cmd('weather clear');
  cmd(`forceload add ${ARENA.x - ARENA.half - 4} ${ARENA.z - ARENA.half - 4} ${ARENA.x + ARENA.half + 4} ${ARENA.z + ARENA.half + 4}`);
  // floor, clear headroom, low wall so nobody runs away forever
  cmd(`fill ${ARENA.x - ARENA.half} ${ARENA.y - 1} ${ARENA.z - ARENA.half} ${ARENA.x + ARENA.half} ${ARENA.y - 1} ${ARENA.z + ARENA.half} stone`);
  cmd(`fill ${ARENA.x - ARENA.half} ${ARENA.y} ${ARENA.z - ARENA.half} ${ARENA.x + ARENA.half} ${ARENA.y + 5} ${ARENA.z + ARENA.half} air`);
  cmd(`fill ${ARENA.x - ARENA.half} ${ARENA.y} ${ARENA.z - ARENA.half} ${ARENA.x + ARENA.half} ${ARENA.y + 3} ${ARENA.z + ARENA.half} stone hollow`);
  cmd(`fill ${ARENA.x - ARENA.half + 1} ${ARENA.y} ${ARENA.z - ARENA.half + 1} ${ARENA.x + ARENA.half - 1} ${ARENA.y + 3} ${ARENA.z + ARENA.half - 1} air`);
}

function resetFighter(name, spawn, kit = KIT) {
  cmd(`gamemode survival ${name}`);
  cmd(`effect clear ${name}`);
  cmd(`clear ${name}`);
  cmd(`tp ${name} ${spawn.x} ${spawn.y} ${spawn.z}`);
  for (const item of kit) cmd(`give ${name} ${item}`);
  // instant_health at high amplifier restores to full; saturation keeps the food
  // bar topped up so nobody loses on hunger instead of skill.
  cmd(`effect give ${name} instant_health 1 20 true`);
  cmd(`effect give ${name} saturation 2 10 true`);
}

// ── fighter ─────────────────────────────────────────────────────────
class Fighter {
  constructor(name, paramOverride) {
    this.name = name;
    this.paramOverride = paramOverride;
    this.deaths = 0;
    this.ready = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const bot = mineflayer.createBot({
        host: HOST, port: PORT, username: this.name, auth: 'offline', version: VERSION, hideErrors: true,
      });
      this.bot = bot;

      bot.on('error', (e) => say(`  ${this.name} error: ${e.message}`));
      bot.on('death', () => {
        this.deaths++;
        this.diedAt = Date.now();
      });

      bot.once('spawn', () => {
        try {
          bot.mcData = mcDataLoader(bot.version);
          installMovement(bot);
          this.reflex = new Reflex(bot).install();
          installGear(bot);
          this.targeting = new Targeting(bot);
          this.combat = new CombatEngine(bot, this.reflex, this.targeting, this.paramOverride);
          this.ready = true;
          resolve(this);
        } catch (err) {
          reject(err);
        }
      });
      setTimeout(() => reject(new Error(`${this.name} never spawned`)), 40000);
    });
  }

  opponentEntity(other) {
    return this.bot.players[other.name]?.entity || null;
  }

  /**
   * Health as it mattered at the end of the round.
   *
   * Reading bot.health directly after a death returns 20, because the player has
   * already respawned — which silently inverted the HP-margin metric and made the
   * loser of every kill look like the healthiest fighter on the field. A fighter
   * that died ended the round on zero, full stop.
   */
  get hp() {
    if (this.deaths > 0) return 0;
    return this.bot.health ?? 0;
  }

  stop() {
    try {
      this.combat?.stop();
    } catch {}
  }

  quit() {
    try {
      this.bot?.quit('spar over');
    } catch {}
  }
}

// ── one duel ────────────────────────────────────────────────────────
async function duel(a, b, round) {
  resetFighter(a.name, A_SPAWN, A_KIT);
  resetFighter(b.name, B_SPAWN, B_KIT);
  await sleep(2500);

  await equipBest(a.bot).catch(() => {});
  await equipBest(b.bot).catch(() => {});
  await sleep(1200);

  a.deaths = 0;
  b.deaths = 0;
  const started = Date.now();

  const ea = a.opponentEntity(b);
  const eb = b.opponentEntity(a);
  if (!ea || !eb) return { round, winner: null, reason: 'fighters cannot see each other' };

  // Both engage simultaneously. Re-issue if the engine breaks off, so a duel ends
  // in a death rather than a stalemate of mutual disengagement.
  const keepFighting = async (self, other) => {
    while (Date.now() - started < ROUND_TIMEOUT_MS && self.deaths === 0 && other.deaths === 0) {
      const target = self.opponentEntity(other);
      if (!target) break;
      await self.combat.fight(target, { timeoutMs: 20000, pursue: true }).catch(() => {});
      await sleep(150);
    }
  };

  await Promise.race([
    Promise.all([keepFighting(a, b), keepFighting(b, a)]),
    (async () => {
      while (Date.now() - started < ROUND_TIMEOUT_MS && a.deaths === 0 && b.deaths === 0) await sleep(200);
    })(),
  ]);

  a.stop();
  b.stop();
  const durationMs = Date.now() - started;

  let winner = null;
  let reason = 'timeout';
  if (a.deaths > 0 && b.deaths === 0) {
    winner = b.name;
    reason = 'kill';
  } else if (b.deaths > 0 && a.deaths === 0) {
    winner = a.name;
    reason = 'kill';
  } else if (a.deaths === 0 && b.deaths === 0) {
    // Nobody died: decide on remaining health, which is the honest tiebreak.
    if (a.hp > b.hp + 1) {
      winner = a.name;
      reason = 'hp advantage';
    } else if (b.hp > a.hp + 1) {
      winner = b.name;
      reason = 'hp advantage';
    } else reason = 'draw';
  } else {
    reason = 'both died';
  }

  const result = {
    round,
    winner,
    reason,
    durationMs,
    aHp: Math.round(a.hp),
    bHp: Math.round(b.hp),
    aSwings: a.combat.swings,
    bSwings: b.combat.swings,
  };
  a.combat.swings = 0;
  b.combat.swings = 0;
  say(`  round ${round}: ${winner ? `${winner} wins` : 'no winner'} (${reason}) — hp ${result.aHp} vs ${result.bHp}, ${Math.round(durationMs / 1000)}s`);
  return result;
}

// ── main ────────────────────────────────────────────────────────────
(async () => {
  if (!FIFO) {
    console.error('SPAR_FIFO is required — the harness needs the server console to build the arena.');
    process.exit(1);
  }

  say(`\nsparring: ${A_NAME} vs ${B_NAME}, ${DUELS} duels`);
  if (ARCH) {
    say(`  opponent archetype: ${ARCH.label}`);
  } else {
    const bDiff = Object.entries(B_PARAMS).map(([k, v]) => `${k}=${v}`).join(' ') || 'defaults';
    say(`  ${B_NAME}: ${bDiff}`);
  }
  const aDiff = Object.entries(A_PARAMS).map(([k, v]) => `${k}=${v}`).join(' ') || 'tuned profile';
  say(`  ${A_NAME}: ${aDiff}\n`);

  buildArena();
  await sleep(1500);

  const a = new Fighter(A_NAME, A_PARAMS);
  const b = new Fighter(B_NAME, B_PARAMS);
  try {
    await a.connect();
    await b.connect();
  } catch (err) {
    console.error(`connect failed: ${err.message}`);
    console.log(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
  await sleep(2000);

  const rounds = [];
  for (let i = 1; i <= DUELS; i++) {
    rounds.push(await duel(a, b, i));
  }

  const aWins = rounds.filter((r) => r.winner === A_NAME).length;
  const bWins = rounds.filter((r) => r.winner === B_NAME).length;
  const draws = rounds.length - aWins - bWins;
  const avgAHp = rounds.reduce((s, r) => s + r.aHp, 0) / rounds.length;
  const avgBHp = rounds.reduce((s, r) => s + r.bHp, 0) / rounds.length;

  const summary = {
    a: A_NAME, b: B_NAME, duels: rounds.length,
    aWins, bWins, draws,
    aWinRate: +(aWins / rounds.length).toFixed(3),
    avgAHp: +avgAHp.toFixed(1),
    avgBHp: +avgBHp.toFixed(1),
    hpMargin: +(avgAHp - avgBHp).toFixed(1),
    rounds,
  };

  say(`\n  ${A_NAME} ${aWins} — ${bWins} ${B_NAME}  (${draws} draws)`);
  say(`  avg hp left: ${summary.avgAHp} vs ${summary.avgBHp}  (margin ${summary.hpMargin > 0 ? '+' : ''}${summary.hpMargin})\n`);

  a.quit();
  b.quit();
  await sleep(600);
  console.log(`SPAR_RESULT ${JSON.stringify(summary)}`);
  process.exit(0);
})();
