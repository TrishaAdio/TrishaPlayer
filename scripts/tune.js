/**
 * THE TUNER — turns guessed combat constants into measured ones.
 *
 * Every candidate profile fights the current baseline head to head in the arena.
 * A candidate is only adopted if it beats the baseline by a margin wide enough to
 * not be noise. Adopted candidates become the new baseline, so improvements stack
 * across a run (a greedy hill-climb, which is the right shape for a search this
 * expensive — every sample costs a real 20-60 second duel).
 *
 * Usage:
 *   SPAR_FIFO=... node scripts/tune.js --duels 4 --rounds 1
 *
 * Writes the winning profile to memory/combat-params.json, which the engine then
 * loads on every future boot.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PARAMS, saveTuned, diffFromDefaults } from '../src/combat/params.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAR = path.join(__dirname, 'spar.js');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const DUELS = Number(arg('duels', 4));
const PASSES = Number(arg('rounds', 1));
const ROUND_TIMEOUT = arg('timeout', 60);

/**
 * Candidates are hypotheses, each with a reason. Blind random search would waste
 * hundreds of real duels; these encode actual PvP theory so the search starts
 * somewhere sensible.
 */
const CANDIDATES = [
  {
    name: 'tighter spacing',
    why: 'sitting closer means less travel time between crits, at the cost of eating more hits',
    patch: { engageRange: 3.1, tooClose: 1.8 },
  },
  {
    name: 'wider spacing',
    why: 'more room to reset sprint and force them to close, trading tempo for safety',
    patch: { engageRange: 3.9, tooClose: 2.4 },
  },
  {
    name: 'faster strafe flips',
    why: 'flipping direction more often should wreck their aim tracking',
    patch: { strafeMinMs: 380, strafeMaxMs: 900 },
  },
  {
    name: 'slower strafe flips',
    why: 'fewer direction changes means more consistent forward pressure',
    patch: { strafeMinMs: 950, strafeMaxMs: 2000 },
  },
  {
    name: 'snappier crit hop',
    why: 'a shorter jump hold gets the swing off earlier in the descent',
    patch: { critJumpHoldMs: 60 },
  },
  {
    name: 'longer crit hop',
    why: 'more airtime is a wider crit window, but delays the hit',
    patch: { critJumpHoldMs: 150 },
  },
  {
    name: 'crits optional',
    why: 'raw swing rate over damage per swing — tests whether crit discipline is actually worth the setup time',
    patch: { requireCrit: false },
  },
  {
    name: 'instant sprint reset',
    why: 'less dead time after each hit means faster re-engagement',
    patch: { sprintResetMs: 0 },
  },
  {
    name: 'no shield cycling',
    why: 'shield raising costs movement speed; tests whether the block is worth it',
    patch: { shieldDuringCooldown: false },
  },
  {
    name: 'aggressive approach',
    why: 'more sprint-jumps while closing makes the approach harder to read',
    patch: { jumpApproachChance: 0.5, sprintApproachFrom: 5 },
  },
];

function runSpar(candidatePatch, baselinePatch, label, duels = DUELS) {
  const res = spawnSync(
    process.execPath,
    [SPAR, '--duels', String(duels), '--timeout', String(ROUND_TIMEOUT), '--quiet',
      '--a', JSON.stringify(candidatePatch), '--b', JSON.stringify(baselinePatch)],
    { encoding: 'utf8', timeout: (duels * (Number(ROUND_TIMEOUT) + 20) + 90) * 1000, env: process.env },
  );

  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const line = out.split('\n').find((l) => l.startsWith('SPAR_RESULT '));
  if (!line) {
    console.log(`    ! ${label}: no result (${(res.stderr || '').trim().split('\n').pop() || 'spar failed'})`);
    return null;
  }
  try {
    return JSON.parse(line.slice('SPAR_RESULT '.length));
  } catch {
    return null;
  }
}

/**
 * Adoption rule — deliberately strict.
 *
 * The first version of this accepted anything above a 50% win rate, and promptly
 * adopted a candidate that went 3-0. Re-running that same candidate against the
 * defaults over six duels gave 2-2. The 3-0 was noise, and adopting noise makes
 * her worse while looking like progress.
 *
 * So now: a candidate must win at least two more decided rounds than it loses, or
 * win more rounds AND carry a clear health margin. Draws count as evidence of
 * nothing. Under-sampled candidates are never adopted.
 */
function beatsBaseline(r) {
  if (!r) return false;
  const decided = r.aWins + r.bWins;
  if (decided < 3) return false; // under-sampled: adopting this is how noise gets in
  if (r.aWins >= r.bWins + 2) return true;
  if (r.aWins > r.bWins && r.hpMargin >= 3) return true;
  return false;
}

(async () => {
  console.log(`\n${'='.repeat(66)}`);
  console.log(`  COMBAT TUNING — ${CANDIDATES.length} candidates x ${DUELS} duels x ${PASSES} pass(es)`);
  console.log(`  every sample is a real duel on a real server`);
  console.log(`${'='.repeat(66)}\n`);

  let baseline = {}; // empty patch = current DEFAULT_PARAMS
  const adopted = [];
  const log = [];

  for (let pass = 1; pass <= PASSES; pass++) {
    if (PASSES > 1) console.log(`\n── pass ${pass} ──`);
    for (const c of CANDIDATES) {
      // Skip candidates that only restate what we already adopted.
      const alreadySame = Object.entries(c.patch).every(([k, v]) => baseline[k] === v);
      if (alreadySame) continue;

      const candidate = { ...baseline, ...c.patch };
      process.stdout.write(`  ${c.name.padEnd(22)} `);
      const r = runSpar(candidate, baseline, c.name);
      if (!r) continue;

      const verdict = beatsBaseline(r);
      console.log(
        `${String(r.aWins).padStart(2)}-${String(r.bWins).padEnd(2)} ` +
        `winrate ${String(Math.round(r.aWinRate * 100)).padStart(3)}%  ` +
        `hp margin ${r.hpMargin > 0 ? '+' : ''}${String(r.hpMargin).padEnd(5)} ` +
        `${verdict ? 'ADOPTED' : 'rejected'}`,
      );
      log.push({ candidate: c.name, why: c.why, ...r, adopted: verdict });

      if (verdict) {
        baseline = candidate;
        adopted.push({ name: c.name, patch: c.patch, aWins: r.aWins, bWins: r.bWins, winRate: r.aWinRate, hpMargin: r.hpMargin });
      }
    }
  }

  console.log(`\n${'='.repeat(66)}`);
  if (!adopted.length) {
    console.log('  no candidate beat the baseline — the hand-reasoned defaults hold up.');
    console.log('  that is a real result, not a failure: the starting profile is sound.');
    console.log(`${'='.repeat(66)}\n`);
    console.log(`TUNE_RESULT ${JSON.stringify({ adopted: [], params: {}, log })}`);
    process.exit(0);
  }

  console.log(`  ${adopted.length} candidate(s) passed the sweep:`);
  for (const a of adopted) {
    console.log(`    ${a.name.padEnd(22)} ${a.aWins}-${a.bWins}  hp margin ${a.hpMargin > 0 ? '+' : ''}${a.hpMargin}`);
  }

  /**
   * CONFIRMATION RUN — the step that stops this tool from lying to itself.
   *
   * Greedy hill-climbing tests each candidate against the *current* baseline, so
   * one bad early adoption inflates everything measured after it. The first run of
   * this tuner did exactly that: a candidate went 3-0 against a baseline that had
   * already been degraded, and lost 1-3 when re-tested against true defaults.
   *
   * So the combined profile now has to beat the original defaults head to head,
   * over a larger sample, before it is allowed anywhere near disk.
   */
  const confirmDuels = Math.max(8, DUELS * 2);
  console.log(`\n  confirming the combined profile against TRUE defaults over ${confirmDuels} duels...`);
  const confirm = runSpar(baseline, {}, 'confirmation', confirmDuels);

  if (!confirm) {
    console.log('  confirmation run failed to produce a result — refusing to save.');
    process.exit(1);
  }

  const confirmed = beatsBaseline(confirm);
  console.log(
    `  result: ${confirm.aWins}-${confirm.bWins} (${confirm.draws} draws), ` +
    `hp margin ${confirm.hpMargin > 0 ? '+' : ''}${confirm.hpMargin} — ${confirmed ? 'CONFIRMED' : 'NOT CONFIRMED'}`,
  );

  if (!confirmed) {
    console.log('\n  the sweep gains did not survive confirmation, so nothing is saved.');
    console.log('  the defaults stay in place. a tuner that adopts noise is worse than no tuner.');
    console.log(`${'='.repeat(66)}\n`);
    console.log(`TUNE_RESULT ${JSON.stringify({ adopted: [], rejectedAfterConfirmation: adopted, confirm, params: {}, log })}`);
    process.exit(0);
  }

  const file = saveTuned({ ...DEFAULT_PARAMS, ...baseline }, {
    duels: confirmDuels,
    winRate: confirm.aWinRate,
    wins: confirm.aWins,
    losses: confirm.bWins,
    hpMargin: confirm.hpMargin,
    adopted: adopted.map((a) => a.name),
    method: 'greedy hill-climb, then confirmed head-to-head against defaults',
  });

  console.log('\n  final profile diff from defaults:');
  for (const row of diffFromDefaults({ ...DEFAULT_PARAMS, ...baseline })) console.log(`    ${row}`);
  console.log(`\n  written to ${file}`);
  console.log(`${'='.repeat(66)}\n`);
  console.log(`TUNE_RESULT ${JSON.stringify({ adopted, confirm, params: baseline, log })}`);
  process.exit(0);
})();
