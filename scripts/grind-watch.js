/**
 * Stands in as RAREAURA, tells her to grind, then watches without helping.
 *
 * Samples her state every 15 seconds and reports: is she moving, is she making
 * progress, what is she holding, how is her health. The point is to catch the exact
 * failure RAREAURA saw over two hours — stalling, wandering, drowning — with a record
 * precise enough to act on.
 */
import mineflayer from 'mineflayer';

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION || '1.21.4';
const WATCH_SECONDS = Number(process.argv[2] || 900);

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: 'RAREAURA', auth: 'offline', version: VERSION, hideErrors: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const samples = [];
let lastPos = null;
let stillFor = 0;

bot.on('chat', (username, message) => {
  if (username === 'RAREAURA') return;
  console.log(`  CHAT  <${username}> ${message}`);
});

bot.once('spawn', async () => {
  console.log(`\nRAREAURA online at ${bot.entity.position.floored()}`);
  // Wait for her to arrive and finish her survey.
  for (let i = 0; i < 40 && !bot.players.Trisha; i++) await sleep(1000);
  if (!bot.players.Trisha) {
    console.log('  !! Trisha never joined');
    process.exit(1);
  }
  await sleep(8000);

  console.log('\n>>> "trisha grind and become powerful"\n');
  bot.chat('trisha grind and become powerful');

  const started = Date.now();
  while (Date.now() - started < WATCH_SECONDS * 1000) {
    await sleep(15000);
    const t = bot.players.Trisha?.entity;
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    if (!t) {
      console.log(`  ${mins}m  (out of range)`);
      samples.push({ mins, seen: false });
      continue;
    }
    const p = t.position;
    const moved = lastPos ? lastPos.distanceTo(p) : 0;
    lastPos = p.clone();
    if (moved < 1) stillFor += 15;
    else stillFor = 0;

    const held = t.heldItem?.name || 'nothing';
    const flag = stillFor >= 45 ? `  <-- STILL FOR ${stillFor}s` : '';
    console.log(`  ${mins}m  at ${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}  moved ${moved.toFixed(1)}m  holding ${held}${flag}`);
    samples.push({ mins, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), moved: +moved.toFixed(1), held, stillFor });
  }

  // Where did she spend her time, and did she ever really settle?
  const stalls = samples.filter((s) => s.stillFor >= 45).length;
  const spread = samples.filter((s) => s.x != null);
  const xs = spread.map((s) => s.x);
  const zs = spread.map((s) => s.z);
  console.log(`\n  samples ${samples.length}, stalled samples ${stalls}`);
  if (xs.length) {
    console.log(`  roamed x ${Math.min(...xs)}..${Math.max(...xs)}, z ${Math.min(...zs)}..${Math.max(...zs)}`);
  }
  console.log(`WATCH_RESULT ${JSON.stringify({ samples: samples.length, stalls })}`);
  bot.quit('done');
  setTimeout(() => process.exit(0), 500);
});

bot.on('error', (e) => console.log(`owner bot error: ${e.message}`));
setTimeout(() => process.exit(0), (WATCH_SECONDS + 120) * 1000);
