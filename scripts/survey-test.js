/**
 * Connects, surveys the area, prints the scout report, then asks the planner for a
 * plan and prints that too. Read-only: she does not act on it.
 *
 * This is the check that the plan is grounded in reality — that it does not propose
 * chopping wood where there are no trees, or a route across an ocean.
 */
import mineflayer from 'mineflayer';
import mcDataLoader from 'minecraft-data';
import { installMovement } from '../src/skills/move.js';
import { surveyArea, surveyBriefing } from '../src/world/survey.js';
import { makePlan, fallbackPlan } from '../src/llm/planner.js';
import { inventorySummary } from '../src/world/state.js';
import { config } from '../src/config.js';

const bot = mineflayer.createBot({
  host: config.mc.host,
  port: config.mc.port,
  username: 'Scout',
  auth: 'offline',
  version: config.mc.version || false,
  hideErrors: true,
});

bot.on('error', (e) => console.log(`error: ${e.message}`));

bot.once('spawn', async () => {
  bot.mcData = mcDataLoader(bot.version);
  installMovement(bot);
  console.log('\nwaiting for chunks to load...');
  await new Promise((r) => setTimeout(r, 9000));

  console.log(`\n${'='.repeat(70)}`);
  console.log('  SCOUT REPORT');
  console.log(`${'='.repeat(70)}\n`);
  const survey = surveyArea(bot, { radius: 96 });
  console.log(surveyBriefing(survey));

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  PLAN FROM ${config.llm.planner}`);
  console.log(`${'='.repeat(70)}\n`);

  const result = await makePlan(bot, {
    reason: 'testing the planner',
    inventorySummary: inventorySummary(bot).join(', '),
  });

  if (result.read) console.log(`  read: ${result.read}`);
  if (result.say) console.log(`  says: "${result.say}"`);
  const steps = result.steps || fallbackPlan(bot, survey);
  console.log(`  source: ${result.steps ? config.llm.planner : 'deterministic fallback'}\n`);
  steps.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.name}(${JSON.stringify(s.args)})`);
    if (s.why) console.log(`     ${s.why}`);
  });

  // The check that matters: does the plan contradict the ground truth?
  console.log(`\n${'='.repeat(70)}`);
  console.log('  SANITY CHECK — is the plan grounded in the survey?');
  console.log(`${'='.repeat(70)}\n`);
  const names = steps.map((s) => s.name);
  const problems = [];
  if (!survey.trees.length && names.includes('chopWood')) problems.push('plans to chop wood but the survey found NO trees');
  if (!survey.animalTotal && names.some((n) => ['butcher', 'getFood', 'forageFood'].includes(n))) {
    problems.push('plans to hunt but the survey found NO animals (acceptable only if it intends to fish/farm)');
  }
  if (survey.water.ocean && names.includes('explore')) problems.push('plans to explore next to an ocean — check it avoids the water bearing');
  console.log(problems.length ? problems.map((p) => `  WARN  ${p}`).join('\n') : '  PASS  nothing in the plan contradicts the ground truth');

  bot.quit('done');
  setTimeout(() => process.exit(0), 600);
});

setTimeout(() => {
  console.log('survey test timed out');
  process.exit(3);
}, 120000);
