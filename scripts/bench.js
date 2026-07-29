/**
 * BENCHMARK — how she does against opponents that are not her.
 *
 * The tuner answers "is this profile better than that profile". It cannot answer
 * "is she actually good", because both sides are her. This runs her tuned profile
 * against modelled opponents — rusher, shield camper, bow kiter, strafer, and a
 * competent all-round human — each with realistic reaction latency, aim error and
 * fumbled clicks.
 *
 * The `mirror` row is the control: it should land near 50%. If it does not, the
 * harness is biased and none of the other numbers mean anything.
 *
 * Usage: SPAR_FIFO=... node scripts/bench.js --duels 6
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCHETYPES } from './archetypes.js';
import { params, paramSource } from '../src/combat/params.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPAR = path.join(__dirname, 'spar.js');

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const DUELS = Number(arg('duels', 6));
const TIMEOUT = arg('timeout', 30);
const ONLY = arg('only', '');

const names = ONLY ? ONLY.split(',') : Object.keys(ARCHETYPES);

function run(archetype) {
  const res = spawnSync(
    process.execPath,
    [SPAR, '--duels', String(DUELS), '--timeout', String(TIMEOUT), '--quiet',
      '--aname', 'Trisha', '--bname', 'Sparring', '--archetype', archetype, '--a', '{}'],
    { encoding: 'utf8', timeout: (DUELS * (Number(TIMEOUT) + 20) + 120) * 1000, env: process.env },
  );
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const line = out.split('\n').find((l) => l.startsWith('SPAR_RESULT '));
  if (!line) return { error: (res.stderr || '').trim().split('\n').pop() || 'no result' };
  try {
    return JSON.parse(line.slice('SPAR_RESULT '.length));
  } catch {
    return { error: 'unparseable result' };
  }
}

console.log(`\n${'='.repeat(72)}`);
console.log('  BENCHMARK — Trisha vs modelled opponents');
console.log(`  profile: ${paramSource()}`);
console.log(`  ${DUELS} duels per archetype, all opponents have human reaction latency`);
console.log(`${'='.repeat(72)}\n`);
console.log(`  ${'opponent'.padEnd(28)} ${'record'.padEnd(9)} ${'win%'.padEnd(6)} hp margin`);
console.log(`  ${'-'.repeat(66)}`);

const rows = [];
for (const name of names) {
  const arch = ARCHETYPES[name];
  const r = run(name);
  if (r.error) {
    console.log(`  ${name.padEnd(28)} ${'ERROR'.padEnd(9)} ${r.error}`);
    continue;
  }
  const decided = r.aWins + r.bWins;
  const winPct = decided ? Math.round((r.aWins / decided) * 100) : 0;
  rows.push({ name, label: arch.label, ...r, winPct });
  console.log(
    `  ${name.padEnd(28)} ${`${r.aWins}-${r.bWins}`.padEnd(9)} ${`${winPct}%`.padEnd(6)} ` +
    `${r.hpMargin > 0 ? '+' : ''}${r.hpMargin}${r.draws ? `   (${r.draws} draws)` : ''}`,
  );
}

console.log(`\n${'='.repeat(72)}`);
const mirror = rows.find((r) => r.name === 'mirror');
if (mirror) {
  const fair = mirror.winPct >= 30 && mirror.winPct <= 70;
  console.log(`  control (mirror): ${mirror.winPct}% — ${fair ? 'harness looks unbiased' : 'HARNESS IS BIASED, other rows are suspect'}`);
}
const real = rows.filter((r) => r.name !== 'mirror');
if (real.length) {
  const totalW = real.reduce((s, r) => s + r.aWins, 0);
  const totalL = real.reduce((s, r) => s + r.bWins, 0);
  const overall = totalW + totalL ? Math.round((totalW / (totalW + totalL)) * 100) : 0;
  console.log(`  overall vs modelled opponents: ${totalW}-${totalL} (${overall}%)`);
  const worst = [...real].sort((a, b) => a.winPct - b.winPct)[0];
  console.log(`  weakest matchup: ${worst.name} at ${worst.winPct}%`);
}
console.log(`${'='.repeat(72)}\n`);
console.log(`BENCH_RESULT ${JSON.stringify({ duels: DUELS, rows })}`);
