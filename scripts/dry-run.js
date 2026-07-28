/**
 * Offline verification — no server, no LLM calls.
 *
 * 1. every module imports cleanly
 * 2. the things RAREAURA actually types map to the right actions on the FAST path
 * 3. the survival ladder resolves rungs correctly, including resume-after-gift
 *
 * Run: npm run dry
 */
import { fastParse } from '../src/chat/commands.js';
import { ACTIONS, isValidAction, actionCatalogue } from '../src/actions.js';
import { LADDER, currentRung, ladderProgress } from '../src/progression.js';
import { config } from '../src/config.js';

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}${extra ? ` ${extra}` : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${extra ? ` ${extra}` : ''}`);
  }
};

// Empty-handed bot: no food, no items. Lets us check the "fetch first" behaviour.
const fakeBot = { username: 'Trisha', inventory: { items: () => [] } };

console.log('\n1. COMMAND UNDERSTANDING (fast path, zero latency)\n');

const CASES = [
  ['trisha come here', 'come'],
  ['trisha cmere', 'come'],
  ['come', 'come'],
  ['lets go attack', 'attack'],
  ['trisha attack that zombie', 'attack'],
  ['kill it', 'attack'],
  ['trisha follow me', 'follow'],
  ['go get diamonds', 'equipBest'], // gears up first, then mines — correct
  ['trisha get diamonds for us', 'equipBest'],
  ['get me some iron', 'branchMine'],
  ['make a base for us', 'base'],
  ['trisha build us a house', 'base'],
  ['get us foods', 'getFood'],
  ['im hungry', 'getFood'],
  ['protect me', 'defend'],
  ['guard me', 'defend'],
  ['stop', 'stop'],
  ['trisha wait', 'stop'],
  ['go home', 'home'],
  ['trisha sleep', 'sleep'],
  ['chop some wood', 'chopWood'],
  ['give me food', 'getFood'], // empty-handed in this test, so she fetches first
  ['gimme 3 diamonds', 'come'],
  ['trisha light this up', 'lightArea'],
  ['make a farm', 'farmCrops'],
  ['trisha gear up', 'equipBest'],
  ['deposit everything', 'deposit'],
  ['trisha explore', 'explore'],
];

for (const [text, expected] of CASES) {
  const parsed = fastParse(fakeBot, config.owner, text);
  const first = parsed?.actions?.[0]?.name;
  const chain = parsed?.actions?.map((a) => a.name).join('->') || 'nothing';
  ok(first === expected || (expected === 'stop' && parsed?.stopOnly), `"${text}"`, `-> ${chain}`);
}

console.log('\n2. STATUS QUERIES (answer, no action)\n');
for (const q of ['wyd', 'status', 'trisha hp', 'where are you']) {
  const parsed = fastParse(fakeBot, config.owner, q);
  ok(parsed?.statusQuery === true, `"${q}"`, '-> status reply');
}

console.log('\n3. EVERY EMITTED ACTION EXISTS IN THE REGISTRY\n');
let bad = [];
for (const [text] of CASES) {
  const parsed = fastParse(fakeBot, config.owner, text);
  for (const a of parsed?.actions || []) if (!isValidAction(a.name)) bad.push(`${text} -> ${a.name}`);
}
ok(bad.length === 0, 'no fast-path rule emits an unknown action', bad.join(', '));

console.log('\n4. MULTI-STEP CHAINS\n');
const dia = fastParse(fakeBot, config.owner, 'go get diamonds');
ok(dia.actions.length >= 3, 'diamond run is a full trip', `-> ${dia.actions.map((a) => a.name).join(' -> ')}`);
const food = fastParse(fakeBot, config.owner, 'get us food');
ok(
  food.actions.some((a) => a.name === 'give'),
  'ows "get US food" ends with handing it over',
  `-> ${food.actions.map((a) => a.name).join(' -> ')}`,
);

console.log('\n5. SURVIVAL LADDER RESOLUTION\n');

const makeBot = (items = [], armorSlots = {}) => ({
  inventory: {
    items: () => items.map((i) => ({ name: i[0], count: i[1], type: 1 })),
    slots: { 5: armorSlots.head, 6: armorSlots.torso, 7: armorSlots.legs, 8: armorSlots.feet },
  },
  food: 20,
  health: 20,
});
const ctxFor = (base = null) => ({ memory: { all: { base, bed: null } }, config: config.ladder, flags: {} });

const fresh = makeBot([]);
ok(currentRung(fresh, ctxFor(null))?.id === 'orient', 'fresh spawn starts at orient');

// Hungry and nothing to eat -> the food rung blocks everything else.
const hungry = makeBot([]);
hungry.food = 3;
ok(currentRung(hungry, ctxFor({ x: 0, y: 64, z: 0 }))?.id === 'emergency_food', 'starving with no food blocks on food');

// Well fed with an empty pack -> straight to wood, food rung is not a blocker.
const wellFed = makeBot([]);
ok(currentRung(wellFed, ctxFor({ x: 0, y: 64, z: 0 }))?.id === 'wood', 'full belly skips the food rung');

const fed = makeBot([['bread', 5]]);
ok(currentRung(fed, ctxFor({ x: 0, y: 64, z: 0 }))?.id === 'wood', 'with food in hand, skips to wood');

const wooded = makeBot([['bread', 5], ['oak_log', 8]]);
ok(currentRung(wooded, ctxFor({ x: 0, y: 64, z: 0 }))?.id === 'wood_tools', 'with logs, moves to tools');

// The important property: gifts let her skip rungs.
const gifted = makeBot(
  [['bread', 12], ['oak_log', 10], ['crafting_table', 1], ['iron_pickaxe', 1], ['iron_sword', 1], ['cobblestone', 30], ['furnace', 1], ['torch', 30], ['shield', 1], ['stone_pickaxe', 1]],
  { head: { name: 'iron_helmet' }, torso: { name: 'iron_chestplate' }, legs: { name: 'iron_leggings' }, feet: { name: 'iron_boots' } },
);
const giftedRung = currentRung(gifted, ctxFor({ x: 0, y: 64, z: 0 }));
ok(
  giftedRung && !['wood', 'wood_tools', 'stone', 'stone_tools', 'iron', 'iron_kit'].includes(giftedRung.id),
  'HAND HER IRON GEAR AND SHE SKIPS SIX RUNGS',
  `-> resumes at "${giftedRung?.id}"`,
);

const progress = ladderProgress(gifted, ctxFor({ x: 0, y: 64, z: 0 }));
ok(progress.doneCount >= 8, 'ladder progress counts correctly', `${progress.doneCount}/${progress.total} done`);

console.log('\n6. REGISTRY HEALTH\n');
ok(Object.keys(ACTIONS).length >= 40, 'action count', `${Object.keys(ACTIONS).length} actions`);
const noRun = Object.entries(ACTIONS).filter(([, d]) => typeof d.run !== 'function');
ok(noRun.length === 0, 'every action has an implementation', noRun.map(([n]) => n).join(', '));
const noGroup = Object.entries(ACTIONS).filter(([, d]) => !d.group);
ok(noGroup.length === 0, 'every action is grouped for the prompt');
ok(actionCatalogue().length > 400, 'catalogue text builds for the prompt', `${actionCatalogue().length} chars`);

console.log(`\n${'='.repeat(60)}`);
console.log(`  ${pass} passed, ${fail} failed`);
console.log(`${'='.repeat(60)}\n`);
process.exit(fail ? 1 : 0);
