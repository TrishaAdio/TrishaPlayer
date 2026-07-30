/**
 * ABORT-SAFE PROGRESS EVIDENCE.
 *
 * A long validation run is usually killed rather than allowed to finish — the window
 * closes, or someone stops it to ask how it is going. If the only summary is printed at
 * the end, killing the process destroys the entire result, and several runs' worth of
 * evidence was lost exactly that way.
 *
 * So the full picture is flushed to disk continuously, and again on the way out:
 *   status.json  — machine readable snapshot, overwritten every few seconds
 *   status.txt   — the same thing readable at a glance
 *   timeline.log — append-only record of milestones, never overwritten
 *
 * Nothing in here can throw into the caller: a reporting failure must never take the bot
 * down with it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../config.js';
import { ladderProgress, ladderStatus } from '../progression.js';

const DIR = process.env.STATUS_DIR || path.join(ROOT, 'memory');
const JSON_FILE = path.join(DIR, 'status.json');
const TEXT_FILE = path.join(DIR, 'status.txt');
const TIMELINE = path.join(DIR, 'timeline.log');

const started = Date.now();
let deaths = 0;
let lastMilestone = '';

const safe = (fn, dflt = null) => {
  try {
    return fn();
  } catch {
    return dflt;
  }
};

const ensureDir = () => {
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {}
};

export function recordDeath(cause) {
  deaths++;
  milestone(`DEATH #${deaths} — ${cause}`);
}

export function deathCount() {
  return deaths;
}

/**
 * Append a milestone. Append-only and flushed immediately, so it survives a SIGKILL —
 * this is the file that answers "how far did she actually get" after an abort.
 */
export function milestone(text) {
  if (!text || text === lastMilestone) return;
  lastMilestone = text;
  ensureDir();
  const line = `${new Date().toISOString()} +${Math.round((Date.now() - started) / 1000)}s ${text}\n`;
  try {
    fs.appendFileSync(TIMELINE, line);
  } catch {}
}

/** Every item she owns, including worn armour and the off-hand. */
function fullInventory(bot) {
  const slots = bot.inventory?.slots || [];
  const out = [];
  for (let i = 0; i < slots.length; i++) {
    const it = slots[i];
    if (!it) continue;
    out.push({ slot: i, name: it.name, count: it.count ?? 1 });
  }
  return out;
}

const ARMOUR = { 5: 'head', 6: 'torso', 7: 'legs', 8: 'feet', 45: 'offhand' };

export function snapshot(bot, brain, executor) {
  return safe(() => {
    const p = bot.entity?.position;
    const lp = safe(() => {
      const r = ladderProgress(bot, brain.ctx());
      return { current: r.current, doneCount: r.doneCount, total: r.total, rows: r.rows };
    }, null);
    const s = ladderStatus;

    const equipped = {};
    for (const [slot, where] of Object.entries(ARMOUR)) {
      const it = bot.inventory?.slots?.[Number(slot)];
      equipped[where] = it ? it.name : null;
    }

    return {
      at: new Date().toISOString(),
      uptimeSec: Math.round((Date.now() - started) / 1000),
      alive: (bot.health ?? 0) > 0,
      deaths,
      health: bot.health ?? null,
      food: bot.food ?? null,
      position: p ? { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) } : null,
      dimension: bot.game?.dimension ?? null,
      gamemode: bot.game?.gameMode ?? null,
      ladder: lp,
      doing: executor?.currentName || null,
      queued: safe(() => brain.plan.map((a) => a.name), []),
      equipped,
      held: bot.heldItem?.name ?? null,
      counts: s
        ? {
            logs: safe(() => s.logs(bot), 0),
            cobblestone: safe(() => s.count(bot, 'cobblestone'), 0),
            ironBudget: safe(() => s.ironBudget(bot), 0),
            ironTarget: s.IRON_TARGET,
            cookedFood: safe(() => s.foodCount(bot), 0),
            rawMeat: safe(() => s.rawMeatCount(bot), 0),
            torches: safe(() => s.ownedCount(bot, 'torch'), 0),
            wearingFullIron: safe(() => s.wearingFullIron(bot), false),
          }
        : null,
      inventory: fullInventory(bot),
      recent: safe(() => executor.history.slice(0, 8).map((h) => ({ name: h.name, ok: h.ok, ms: h.ms, detail: h.detail || h.reason })), []),
    };
  }, null);
}

function render(s) {
  if (!s) return 'no snapshot available\n';
  const c = s.counts || {};
  const inv = s.inventory.map((i) => `${i.count}x ${i.name}`).join(', ') || '(empty)';
  return [
    `TRISHA STATUS  ${s.at}   uptime ${s.uptimeSec}s`,
    `alive=${s.alive}  deaths=${s.deaths}  hp=${s.health}  food=${s.food}  gamemode=${s.gamemode}`,
    `position ${s.position ? `${s.position.x}, ${s.position.y}, ${s.position.z}` : '?'}  (${s.dimension})`,
    `rung ${s.ladder?.current ?? '?'}  (${s.ladder?.doneCount ?? '?'}/${s.ladder?.total ?? '?'} done)`,
    `doing ${s.doing || 'idle'}   queued: ${s.queued.join(' -> ') || 'nothing'}`,
    '',
    'GOAL — FULL IRON KIT',
    `  wearing full iron : ${c.wearingFullIron}`,
    `  helmet     : ${s.equipped.head ?? '-'}`,
    `  chestplate : ${s.equipped.torso ?? '-'}`,
    `  leggings   : ${s.equipped.legs ?? '-'}`,
    `  boots      : ${s.equipped.feet ?? '-'}`,
    `  off-hand   : ${s.equipped.offhand ?? '-'}`,
    `  holding    : ${s.held ?? '-'}`,
    `  iron budget: ${c.ironBudget}/${c.ironTarget}`,
    '',
    `resources: logs ${c.logs}  cobble ${c.cobblestone}  torches ${c.torches}  food ${c.cookedFood} cooked + ${c.rawMeat} raw`,
    '',
    `inventory: ${inv}`,
    '',
    'recent actions:',
    ...s.recent.map((r) => `  ${r.ok ? 'ok    ' : 'FAILED'} ${r.name} (${Math.round((r.ms || 0) / 1000)}s) ${r.detail || ''}`),
    '',
  ].join('\n');
}

/** Write the current snapshot to disk. Cheap enough to call every few seconds. */
export function flush(bot, brain, executor) {
  try {
    ensureDir();
    const s = snapshot(bot, brain, executor);
    if (!s) return;
    fs.writeFileSync(JSON_FILE, JSON.stringify(s, null, 2));
    fs.writeFileSync(TEXT_FILE, render(s));
  } catch {}
}

/**
 * Install the reporter: a periodic flush plus a final one on every way the process can
 * end. The exit hooks are the whole point — an aborted run must still leave evidence.
 */
export function installReporter(bot, brain, executor, { everyMs = 10000 } = {}) {
  ensureDir();
  milestone(`run started — owner ${config.owner}, ${config.mc.host}:${config.mc.port}`);

  const timer = setInterval(() => flush(bot, brain, executor), everyMs);
  timer.unref?.();

  const finalWrite = (why) => {
    milestone(`run ended (${why})`);
    flush(bot, brain, executor);
  };

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => finalWrite(sig));
  }
  process.on('exit', () => finalWrite('exit'));
  process.on('uncaughtException', () => finalWrite('uncaughtException'));

  return { flush: () => flush(bot, brain, executor), milestone };
}
