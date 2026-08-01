/**
 * Offline verification — no server, no LLM calls.
 *
 * 1. every module imports cleanly
 * 2. the things RAREAURA actually types map to the right actions on the FAST path
 * 3. the survival ladder resolves rungs correctly, including resume-after-gift
 *
 * Run: npm run dry
 */
import { fastParse, looksLikeQuestion } from '../src/chat/commands.js';
import { ACTIONS, isValidAction, actionCatalogue } from '../src/actions.js';
import { LADDER, currentRung, ladderProgress, ladderStatus } from '../src/progression.js';
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

console.log('\n2. QUESTIONS ARE CONVERSATION, NOT ORDERS\n');
// Live regression: "in minecraft nights are how min long?" made her abandon her job
// to go build a shelter and sleep. Command verbs must still beat question marks.
for (const [text, expected] of [
  ['in minecraft nights are how min long?', true],
  ['how many woods u have', true],
  ['what are you doing', true],
  ['do you love me?', true],
  ['where are you', true],
  ['can you go chop some trees?', false],
  ['trisha come here', false],
  ['give me 3 woods', false],
  ['go get diamonds', false],
  ['quote of the day', false],
]) {
  ok(looksLikeQuestion(text) === expected, `"${text}"`, `question=${looksLikeQuestion(text)}`);
}

console.log('\n3. STATUS QUERIES (answer, no action)\n');
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

const makeBot = (items = [], armorSlots = {}, extra = {}) => ({
  inventory: {
    items: () => items.map((i) => ({ name: i[0], count: i[1], type: 1, enchants: i[2] || [] })),
    slots: { 5: armorSlots.head, 6: armorSlots.torso, 7: armorSlots.legs, 8: armorSlots.feet },
  },
  food: 20,
  health: 20,
  experience: { level: extra.xp ?? 0 },
  ...extra,
});
const ctxFor = (base = null, waypoints = {}, extra = {}) => ({
  memory: { all: { base, bed: null, waypoints, ...extra } },
  config: config.ladder,
  flags: { returnedHome: true, ...(extra.flags || {}) },
});

/** Context for a bot that has already finished the early game. */
const lateCtx = (waypoints = {}) =>
  ctxFor({ x: 0, y: 64, z: 0 }, waypoints, { shelterBuilt: true, bed: { x: 0, y: 64, z: 2 } });

const DIAMOND_ARMOR = {
  head: { name: 'diamond_helmet', enchants: [] },
  torso: { name: 'diamond_chestplate', enchants: [] },
  legs: { name: 'diamond_leggings', enchants: [] },
  feet: { name: 'diamond_boots', enchants: [] },
};
const ENCHANTED_ARMOR = {
  head: { name: 'diamond_helmet', enchants: [{ name: 'protection', lvl: 4 }] },
  torso: { name: 'diamond_chestplate', enchants: [{ name: 'protection', lvl: 4 }] },
  legs: { name: 'diamond_leggings', enchants: [{ name: 'protection', lvl: 4 }] },
  feet: { name: 'diamond_boots', enchants: [{ name: 'protection', lvl: 4 }] },
};
const FULL_KIT = [
  ['bread', 12], ['oak_log', 10], ['crafting_table', 1], ['furnace', 1], ['torch', 30],
  ['shield', 1], ['cobblestone', 30], ['water_bucket', 1], ['diamond', 4],
  ['diamond_pickaxe', 1], ['diamond_sword', 1], ['cooked_beef', 10],
];

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

console.log('\n5b. THE IRON ECONOMY MUST ADD UP\n');

// helmet 5 + chestplate 8 + leggings 7 + boots 4 + pickaxe 3 + sword 2 + shield 1
ok(ladderStatus.IRON_FOR_KIT === 30, 'the requested iron kit really costs 30 ingots', `${ladderStatus.IRON_FOR_KIT}`);
ok(ladderStatus.IRON_TARGET >= 30, 'the ladder target is not short of the kit', `target ${ladderStatus.IRON_TARGET}`);

const ironRung = LADDER.find((r) => r.id === 'iron');
const kitRung = LADDER.find((r) => r.id === 'iron_kit');

// Mined the ore but not yet smelted it.
const rawIron = makeBot([['raw_iron', ladderStatus.IRON_TARGET]]);
ok(ironRung.done(rawIron, lateCtx()), 'raw ore satisfies the iron rung', `budget ${ladderStatus.ironBudget(rawIron)}`);

/**
 * THE OSCILLATION. Half the iron is now armour on her body and the loose ingots are
 * gone. The old predicate counted loose ingots only, so this state sent her back down
 * the mine for iron she was already wearing.
 */
const midCraft = makeBot(
  [['iron_pickaxe', 1], ['iron_sword', 1], ['shield', 1], ['iron_ingot', 3]],
  { head: { name: 'iron_helmet' }, torso: { name: 'iron_chestplate' }, legs: { name: 'iron_leggings' }, feet: { name: 'iron_boots' } },
);
ok(ironRung.done(midCraft, lateCtx()), 'spending iron on gear does NOT un-do the iron rung', `budget ${ladderStatus.ironBudget(midCraft)}`);
ok(kitRung.done(midCraft, lateCtx()), 'full iron kit counts as complete', 'all four worn + pick + sword + shield');

// A shield lives in the off-hand (slot 45), which inventory.items() never reports.
const offhandShield = makeBot(
  [['iron_pickaxe', 1], ['iron_sword', 1], ['iron_ingot', 3]],
  { head: { name: 'iron_helmet' }, torso: { name: 'iron_chestplate' }, legs: { name: 'iron_leggings' }, feet: { name: 'iron_boots' } },
);
offhandShield.inventory.slots[45] = { name: 'shield', count: 1 };
ok(kitRung.done(offhandShield, lateCtx()), 'an equipped off-hand shield still counts as owned', 'slot 45 is read');

// Four equipped items that are not a matching iron set must NOT pass.
const junkArmour = makeBot(
  [['iron_pickaxe', 1], ['iron_sword', 1], ['shield', 1]],
  { head: { name: 'leather_helmet' }, torso: { name: 'golden_chestplate' }, legs: { name: 'leather_leggings' }, feet: { name: 'golden_boots' } },
);
ok(!kitRung.done(junkArmour, lateCtx()), 'four unrelated equipped pieces are not full iron armour', 'rejected');

// Cobblestone spent on the stone kit must not send her back to the stone rung.
const stoneRung = LADDER.find((r) => r.id === 'stone');
const spentCobble = makeBot([['cobblestone', 6], ['stone_pickaxe', 2], ['stone_sword', 1], ['furnace', 1]]);
ok(stoneRung.done(spentCobble, lateCtx()), 'spending cobble on the stone kit does NOT un-do the stone rung', '6 cobble left');

/**
 * THE THREE-HOUR BUG. She held 33 ingots' worth of iron with no pickaxe and the strictly
 * ordered ladder sent her back to `wood`, so iron_kit was never reachable. With the iron
 * already mined, the next rung must be the one that turns it into armour.
 */
const ironNoTools = makeBot([['raw_iron', 33], ['oak_log', 6]]);
const ironRung2 = currentRung(ironNoTools, lateCtx());
ok(
  ironRung2 && !['wood_tools', 'stone', 'stone_tools', 'mining_kit'].includes(ironRung2.id),
  '33 iron and no pickaxe goes to the kit, not back to wooden tools',
  `-> "${ironRung2?.id}"`,
);
ok(ironRung2?.id === 'iron_kit', 'and specifically to iron_kit', `-> "${ironRung2?.id}"`);

// Every optional rung is genuinely marked, so an unsatisfiable one can be parked.
const optional = LADDER.filter((r) => r.optional).map((r) => r.id);
ok(optional.includes('bed') && optional.includes('torches'), 'rungs that a world may not support are optional', optional.join(', '));

console.log('\n6. ENDGAME LADDER (enchanting is the real power ceiling)\n');

// Fully kitted in plain diamond -> the next job is obsidian for a table.
const diamondReady = makeBot(FULL_KIT, DIAMOND_ARMOR, { xp: 5 });
const dr = currentRung(diamondReady, lateCtx());
ok(dr?.id === 'obsidian', 'full plain diamond moves on to obsidian', `-> ${dr?.id}`);

// Table and shelves up, level 30 reached -> time to actually enchant.
const readyToEnchant = makeBot(
  [...FULL_KIT, ['obsidian', 4], ['book', 15]],
  DIAMOND_ARMOR,
  { xp: 30 },
);
const rte = currentRung(readyToEnchant, lateCtx({ enchanting: { x: 1, y: 64, z: 1 } }));
ok(rte?.id === 'enchanted_kit', 'table + books + level 30 leads to enchanting', `-> ${rte?.id}`);

// Enchanted gear detected via prismarine-item's enchants getter.
const enchanted = makeBot(
  [...FULL_KIT, ['diamond_sword', 1, [{ name: 'sharpness', lvl: 5 }]]],
  ENCHANTED_ARMOR,
  { xp: 12 },
);
ok(
  require_enchantCount(enchanted) >= 4,
  'enchanted armour is recognised',
  `${require_enchantCount(enchanted)} enchanted pieces`,
);
const er = currentRung(enchanted, lateCtx({ enchanting: { x: 1, y: 64, z: 1 } }));
ok(
  er === null || ['gapples', 'netherite_ingots'].includes(er.id),
  'enchanted kit skips straight past the setup rungs',
  `-> ${er?.id ?? 'ladder complete'}`,
);

// The netherite rung must never be a wall, since the smithing template is
// bastion-only and unreachable for an unattended bot.
const noPick = makeBot([['bread', 5]], ENCHANTED_ARMOR, { xp: 5 });
const nr = LADDER.find((r) => r.id === 'netherite_ingots');
ok(nr.done(noPick, ctxFor({ x: 0, y: 64, z: 0 })), 'netherite rung never blocks the ladder', 'optional as designed');

function require_enchantCount(bot) {
  return ladderStatus.enchantedCount(bot);
}

console.log('\n7. REGISTRY HEALTH\n');
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
