/**
 * Verifies the ZenAPI relay and picks Trisha's model tiers from evidence.
 *
 * For each candidate model:
 *   1. liveness  — does it answer at all, how fast
 *   2. schema    — given a realistic game state, does it return valid decision JSON
 *   3. judgement — is the action it picked actually sane for that situation
 *
 * Run: npm run probe
 */
import { config, assertConfig } from '../src/config.js';
import { complete, extractJson, pingModel } from '../src/llm/client.js';

const CANDIDATES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4.8', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5.5'];

// A genuinely dangerous situation. A good model retreats/eats/blocks.
// A bad one goes mining. This is the real test.
const SCENARIO = {
  health: 6,
  food: 3,
  position: { x: -218, y: 12, z: 91 },
  dimension: 'overworld',
  time: 'night',
  hostiles: [
    { name: 'skeleton', distance: 9.2, hasLineOfSight: true },
    { name: 'zombie', distance: 4.1, hasLineOfSight: true },
  ],
  inventory: ['iron_sword x1', 'bread x3', 'shield x1', 'cobblestone x41', 'torch x8'],
  equipped: { hand: 'iron_pickaxe', offhand: null, armor: 'none' },
  owner: { online: true, distance: 140 },
  currentGoal: 'mine iron_ore x8',
};

const SCHEMA_PROMPT = `You are the decision core of a Minecraft player. Reply with ONLY a JSON object:
{"say": string|null, "action": {"name": string, "args": object}, "why": string}

Valid action names: goto, follow, come, flee, explore, home, mine, chopWood, collectDrops,
craft, smelt, equipBest, shelter, build, placeBlock, lightArea, attack, defend, retreat,
eat, sleep, deposit, withdraw, give, idle, stop.

Pick the single best next action for this game state:
${JSON.stringify(SCENARIO, null, 2)}`;

const GOOD = ['eat', 'retreat', 'shelter', 'flee', 'equipBest', 'build', 'placeBlock', 'attack', 'defend'];
const BAD = ['mine', 'explore', 'chopWood', 'idle', 'collectDrops', 'smelt', 'goto'];

const pad = (s, n) => String(s).padEnd(n);
const ms = (n) => `${String(n).padStart(5)}ms`;

async function probeModel(model) {
  const live = await pingModel(model);
  if (!live.ok) return { model, live, verdict: 'DEAD', detail: live.error || `said "${live.sample}"` };

  const t0 = Date.now();
  let raw = '';
  try {
    raw = await complete({
      model,
      messages: [{ role: 'user', content: SCHEMA_PROMPT }],
      maxTokens: 500,
      temperature: 0.2,
      attempts: 1,
    });
  } catch (err) {
    return { model, live, verdict: 'SCHEMA-FAIL', detail: String(err?.message || err) };
  }
  const decisionMs = Date.now() - t0;
  const json = extractJson(raw);

  if (!json) return { model, live, decisionMs, verdict: 'NO-JSON', detail: raw.slice(0, 80).replace(/\s+/g, ' ') };

  const name = json?.action?.name;
  if (!name) return { model, live, decisionMs, verdict: 'BAD-SHAPE', detail: JSON.stringify(json).slice(0, 80) };

  const cleanJson = !/```/.test(raw) && raw.trim().startsWith('{');
  let verdict = 'OK';
  if (GOOD.includes(name)) verdict = 'GOOD';
  else if (BAD.includes(name)) verdict = 'POOR';
  else verdict = 'UNKNOWN-ACT';

  return {
    model,
    live,
    decisionMs,
    verdict,
    action: name,
    cleanJson,
    say: json.say || '',
    detail: `${name}(${JSON.stringify(json.action.args || {}).slice(0, 40)}) ${cleanJson ? '' : '[fenced]'}`,
  };
}

const problems = assertConfig().filter((p) => p.includes('ZEN_API_KEY'));
if (problems.length) {
  console.error(`\n  ${problems[0]}\n  Copy .env.example to .env and put your sk-... key in it.\n`);
  process.exit(1);
}

console.log(`\n  relay: ${config.llm.baseURL}`);
console.log(`  testing ${CANDIDATES.length} models against a low-HP night-time emergency\n`);
console.log(`  ${pad('model', 22)} ${pad('ping', 8)} ${pad('decide', 8)} ${pad('verdict', 13)} action / notes`);
console.log(`  ${'-'.repeat(95)}`);

const results = [];
for (const model of CANDIDATES) {
  const r = await probeModel(model);
  results.push(r);
  console.log(
    `  ${pad(r.model, 22)} ${pad(r.live.ok ? ms(r.live.ms) : '-', 8)} ${pad(r.decisionMs ? ms(r.decisionMs) : '-', 8)} ${pad(r.verdict, 13)} ${r.detail || ''}`,
  );
  if (r.say) console.log(`  ${' '.repeat(22)} said: "${r.say}"`);
}

const usable = results.filter((r) => r.verdict === 'GOOD' || r.verdict === 'OK');
const smart = usable.filter((r) => r.verdict === 'GOOD');
const fastest = [...usable].sort((a, b) => a.decisionMs - b.decisionMs)[0];
const bestJudge = [...smart].sort((a, b) => a.decisionMs - b.decisionMs)[0];

console.log(`\n  ${usable.length}/${results.length} usable, ${smart.length} made a genuinely good call.`);
if (fastest) console.log(`  recommended MODEL_FAST  = ${fastest.model}  (${fastest.decisionMs}ms)`);
if (bestJudge) console.log(`  recommended MODEL_SMART = ${bestJudge.model}`);
if (!usable.length) console.log('  nothing usable — check the key, or the model names against /api-docs');
console.log('');
