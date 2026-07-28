/**
 * Connects a stand-in for RAREAURA, gives Trisha real orders in chat, and measures
 * whether she actually obeys — distance closed, follow held, replies received.
 *
 * Usage: node scripts/fake-owner.js [seconds]
 */
import mineflayer from 'mineflayer';

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION || '1.21.4';
const NAME = process.env.OWNER || 'RAREAURA';

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, auth: 'offline', version: VERSION });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const replies = [];

bot.on('chat', (username, message) => {
  if (username === NAME) return;
  replies.push(`<${username}> ${message}`);
  console.log(`  HEARD  <${username}> ${message}`);
});

const trisha = () => bot.players.Trisha?.entity;
const distToTrisha = () => {
  const t = trisha();
  return t ? +bot.entity.position.distanceTo(t.position).toFixed(1) : null;
};

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'}   ${name} — ${detail}`);
}

bot.once('spawn', async () => {
  console.log(`\n${NAME} spawned at ${bot.entity.position.floored()}`);
  await sleep(6000);

  if (!bot.players.Trisha) {
    console.log('  !! Trisha is not on the server');
    process.exit(1);
  }

  // ── 1. "come here" ────────────────────────────────────────
  const before = distToTrisha();
  console.log(`\n[test] "trisha come here"  (she is ${before}m away)`);
  bot.chat('trisha come here');
  let best = before;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const d = distToTrisha();
    if (d != null && d < best) best = d;
    if (best <= 4) break;
  }
  record('come here', best < before - 2 || best <= 4, `closed from ${before}m to ${best}m`);

  // ── 2. status query ───────────────────────────────────────
  console.log('\n[test] "trisha wyd"');
  const repliesBefore = replies.length;
  bot.chat('trisha wyd');
  for (let i = 0; i < 12 && replies.length === repliesBefore; i++) await sleep(1000);
  record('status query', replies.length > repliesBefore, replies[replies.length - 1] || 'no reply');

  // ── 3. follow, while walking away ─────────────────────────
  console.log('\n[test] "trisha follow me" then walking off');
  bot.chat('trisha follow me');
  await sleep(3000);
  bot.setControlState('forward', true);
  bot.setControlState('sprint', true);
  await sleep(9000);
  bot.setControlState('forward', false);
  bot.setControlState('sprint', false);
  await sleep(3000);
  const followDist = distToTrisha();
  record('follow me', followDist != null && followDist < 12, `${followDist}m behind after a sprint`);

  // ── 4. interrupt with stop ────────────────────────────────
  console.log('\n[test] "trisha stop"');
  const rb2 = replies.length;
  bot.chat('trisha stop');
  for (let i = 0; i < 10 && replies.length === rb2; i++) await sleep(1000);
  const posA = trisha()?.position.clone();
  await sleep(4000);
  const posB = trisha()?.position;
  const moved = posA && posB ? +posA.distanceTo(posB).toFixed(1) : null;
  record('stop', moved != null && moved < 3, `moved ${moved}m in 4s after stop`);

  // ── 5. an order that needs the LLM path ───────────────────
  console.log('\n[test] "trisha can you go chop some trees for us"');
  const rb3 = replies.length;
  bot.chat('trisha can you go chop some trees for us');
  for (let i = 0; i < 20 && replies.length === rb3; i++) await sleep(1000);
  record('freeform order', replies.length > rb3, replies[replies.length - 1] || 'no reply');

  console.log(`\n${'='.repeat(58)}`);
  const passed = results.filter((r) => r.passed).length;
  console.log(`  OWNER TESTS: ${passed}/${results.length} passed`);
  console.log(`${'='.repeat(58)}\n`);
  bot.quit('done');
  process.exit(passed === results.length ? 0 : 2);
});

bot.on('error', (e) => console.log(`owner bot error: ${e.message}`));
setTimeout(() => {
  console.log('owner test timed out');
  process.exit(3);
}, Number(process.argv[2] || 180) * 1000);
