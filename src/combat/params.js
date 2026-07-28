/**
 * TUNABLE COMBAT PARAMETERS
 *
 * Every number that governs how she fights lives here instead of being buried as a
 * magic constant in the engine. That exists for one reason: `scripts/tune.js` runs
 * hundreds of real duels against a baseline and sweeps these values, so her combat
 * profile ends up **measured** rather than guessed by me.
 *
 * Precedence: tuned file  >  env override  >  defaults.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../util/log.js';

const FILE = path.join(config.memoryDir, 'combat-params.json');

/** The baseline. Hand-reasoned starting point; the tuner improves on it. */
export const DEFAULT_PARAMS = {
  // ── spacing ──────────────────────────────────────────────
  reach: 3.0,              // hard cap on swing distance. vanilla legal.
  engageRange: 3.4,        // where she likes to sit while circling
  tooClose: 2.1,          // back off below this so she keeps her reach advantage
  pursueRange: 24,         // give up beyond this
  sprintApproachFrom: 8,   // start sprint-jumping to close from here

  // ── swing timing ─────────────────────────────────────────
  cooldownSlackMs: 0,      // extra wait past the cooldown before swinging
  critJumpHoldMs: 90,      // how long the jump key is held to set up a crit
  critWindowVy: -0.08,     // must be descending at least this fast to crit
  requireCrit: true,       // only swing on a crit when one is achievable
  sprintResetMs: 40,       // pause between sprint off/on after a hit

  // ── movement ─────────────────────────────────────────────
  strafeMinMs: 700,        // strafe direction flip window, low end
  strafeMaxMs: 1500,       // and high end. unpredictability matters.
  jumpApproachChance: 0.25,

  // ── defence ──────────────────────────────────────────────
  shieldDuringCooldown: true,
  shieldRange: 4.0,        // only bother shielding this close
  breakOffHp: 6,           // abandon the fight below this
  healHp: 8,               // gapple/potion threshold

  // ── ranged ───────────────────────────────────────────────
  bowDrawMs: 1150,         // full draw
  bowLeadFactor: 1.0,      // multiplier on predicted target movement
  bowDropFactor: 0.055,    // gravity compensation per block of distance

  // ── creeper doctrine ─────────────────────────────────────
  creeperShootRange: 9,
  creeperHitRunBackoffMs: 750,
  creeperMinHp: 14,
};

/** Which knobs the tuner is allowed to move, and the range it may explore. */
export const TUNABLE = {
  engageRange: [2.8, 4.2],
  tooClose: [1.6, 2.8],
  cooldownSlackMs: [0, 120],
  critJumpHoldMs: [50, 180],
  sprintResetMs: [0, 120],
  strafeMinMs: [300, 1100],
  strafeMaxMs: [800, 2200],
  jumpApproachChance: [0, 0.6],
  requireCrit: [true, false],
  shieldDuringCooldown: [true, false],
};

let active = { ...DEFAULT_PARAMS };
let source = 'defaults';

function fromEnv() {
  // TRISHA_COMBAT_PARAMS='{"engageRange":3.1}' — used by the tuner per duel.
  const raw = process.env.TRISHA_COMBAT_PARAMS;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? parsed : null;
  } catch (err) {
    log.warn(`TRISHA_COMBAT_PARAMS is not valid JSON: ${err.message}`);
    return null;
  }
}

function fromFile() {
  try {
    if (!fs.existsSync(FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw?.params && typeof raw.params === 'object' ? raw : null;
  } catch (err) {
    log.warn(`could not read tuned combat params: ${err.message}`);
    return null;
  }
}

/** Only accept keys we know about, and coerce to the right type. */
export function sanitise(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_PARAMS)) continue;
    const def = DEFAULT_PARAMS[k];
    if (typeof def === 'boolean') out[k] = typeof v === 'boolean' ? v : /^(1|true|yes)$/i.test(String(v));
    else if (typeof def === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else out[k] = v;
  }
  return out;
}

export function loadParams() {
  active = { ...DEFAULT_PARAMS };
  source = 'defaults';

  const file = fromFile();
  if (file) {
    active = { ...active, ...sanitise(file.params) };
    source = `tuned (${file.winRate != null ? `${Math.round(file.winRate * 100)}% win rate over ${file.duels} duels` : 'saved profile'})`;
  }

  const env = fromEnv();
  if (env) {
    active = { ...active, ...sanitise(env) };
    source = 'env override';
  }

  // Keep the invariants the engine relies on.
  if (active.strafeMaxMs < active.strafeMinMs + 100) active.strafeMaxMs = active.strafeMinMs + 100;
  if (active.engageRange < active.reach) active.engageRange = active.reach + 0.2;
  if (active.tooClose >= active.engageRange) active.tooClose = active.engageRange - 0.5;

  log.info(`combat params: ${source}`);
  return active;
}

export function params() {
  return active;
}

export function paramSource() {
  return source;
}

export function saveTuned(patch, meta = {}) {
  try {
    fs.mkdirSync(config.memoryDir, { recursive: true });
    const body = {
      savedAt: new Date().toISOString(),
      ...meta,
      params: sanitise(patch),
    };
    fs.writeFileSync(FILE, JSON.stringify(body, null, 2));
    return FILE;
  } catch (err) {
    log.warn(`could not save tuned params: ${err.message}`);
    return null;
  }
}

/** Human-readable diff against the baseline, for logs and commit messages. */
export function diffFromDefaults(p = active) {
  const rows = [];
  for (const [k, v] of Object.entries(p)) {
    if (DEFAULT_PARAMS[k] !== v) rows.push(`${k}: ${DEFAULT_PARAMS[k]} -> ${v}`);
  }
  return rows;
}

loadParams();
