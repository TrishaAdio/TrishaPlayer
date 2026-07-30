/**
 * THE PLANNER — one good think, instead of a hundred cheap ones.
 *
 * Previously she re-decided her life every six seconds on the fast model, with no
 * knowledge of her surroundings. The result was exactly what RAREAURA described:
 * "like someone who doesn't have any purpose."
 *
 * Now, on spawn (and after a death or a real setback), she surveys the area and sends
 * that briefing to the strong model — claude-opus-4.8 — which returns an ordered plan
 * of concrete objectives with real coordinates. She then works that plan instead of
 * improvising. Costly once, cheap forever after.
 */
import { config } from '../config.js';
import { log } from '../util/log.js';
import { completeJson } from './client.js';
import { personaBrief } from './persona.js';
import { actionCatalogue, isValidAction } from '../actions.js';
import { surveyArea, surveyBriefing } from '../world/survey.js';

/** Turn the model's plan into actions the executor will accept. */
function sanitisePlan(raw) {
  if (!raw || !Array.isArray(raw.plan)) return null;
  const steps = [];
  for (const step of raw.plan.slice(0, 12)) {
    const name = step?.action?.name ?? step?.name;
    if (!name || !isValidAction(name)) {
      log.warn(`planner proposed unknown action "${name}" — dropped`);
      continue;
    }
    const args = step?.action?.args ?? step?.args ?? {};
    steps.push({
      name,
      args: typeof args === 'object' && args ? args : {},
      why: String(step?.why || step?.goal || '').slice(0, 120),
    });
  }
  return steps.length ? steps : null;
}

/**
 * Build a plan for right now, from what is actually on the ground.
 */
export async function makePlan(bot, { reason = 'spawn', inventorySummary = '', extra = '' } = {}) {
  const survey = surveyArea(bot, { radius: 96 });
  const briefing = surveyBriefing(survey);

  const system = `${personaBrief()}

You are planning your own next hour in Minecraft, and you have just scouted the area.

Actions you can perform:
${actionCatalogue()}

Reply with ONLY JSON:
{"read": "one sentence on what this place is", "plan": [{"action": {"name": "...", "args": {}}, "why": "short"}], "say": "one short chat line or null"}

HARD RULES, learned from failing at this before:
- Plan ONLY against what the scout report actually shows. If it says there are no
  trees, do not plan to chop wood. If it says there are no animals, do not plan to
  hunt. Choose something that exists.
- Never plan a route across water. Large water means drowning; go around or ignore it.
- Use real coordinates from the report in your args wherever an action takes them.
- 4 to 8 steps. Order them so each one is possible when it is reached: tools before
  mining, wood before crafting, food before a long trip.
- Prefer securing food, tools and a safe base before anything ambitious.
- Every step must use an exact action name from the list above.
- Args must be machine-usable: numbers for counts and coordinates, exact block and
  item ids like "oak_log" or "iron_ore". Never a word like "small" where a number
  belongs.`;

  const user = `Scout report:
${briefing}

What she is carrying: ${inventorySummary || 'nothing'}
Health ${Math.round(bot.health ?? 20)}/20, food ${Math.round(bot.food ?? 20)}/20.
Planning because: ${reason}
${extra}`;

  try {
    const json = await completeJson({
      tier: 'smart',
      model: config.llm.planner || undefined,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 1200,
      temperature: 0.3,
      // The planner prompt is long and opus is deliberate; the default 20s budget was
      // timing it out repeatedly ("planner failed: Request timed out"), which dropped
      // her back to improvising. This one call is worth waiting for.
      timeoutMs: 60000,
    });

    const steps = sanitisePlan(json);
    if (!steps) {
      log.warn('planner returned nothing usable');
      return { steps: null, survey, briefing, read: json?.read || null, say: json?.say || null };
    }

    log.brain(`plan (${reason}): ${steps.map((s) => s.name).join(' -> ')}`);
    if (json.read) log.brain(`read on the area: ${json.read}`);
    return { steps, survey, briefing, read: json.read || null, say: json.say || null };
  } catch (err) {
    log.warn(`planner failed: ${err.message}`);
    return { steps: null, survey, briefing, read: null, say: null };
  }
}

/**
 * A deterministic fallback plan, used when the model is unreachable or returns
 * rubbish. Still grounded in the survey — it just does not need an LLM to exist.
 */
export function fallbackPlan(bot, survey) {
  const steps = [];
  const has = (n) => bot.inventory.items().some((i) => i.name.includes(n));

  if (survey.trees.length && !has('_log') && !has('planks')) {
    const t = survey.trees[0];
    steps.push({ name: 'goto', args: { x: t.x, y: t.y, z: t.z, range: 3 }, why: 'the nearest grove' });
    steps.push({ name: 'chopWood', args: { count: 12 }, why: 'wood for tools' });
  }
  if (!has('_pickaxe')) {
    steps.push({ name: 'craft', args: { item: 'crafting_table', count: 1 }, why: 'need a bench' });
    steps.push({ name: 'craft', args: { item: 'wooden_pickaxe', count: 1 }, why: 'first tool' });
    steps.push({ name: 'craft', args: { item: 'wooden_sword', count: 1 }, why: 'do not fight barehanded' });
  }
  if (survey.animalTotal > 0) {
    steps.push({ name: 'getFood', args: { count: 6 }, why: 'animals are right here' });
  }
  steps.push({ name: 'mine', args: { block: 'stone', count: 24 }, why: 'stone is always underground' });
  steps.push({ name: 'equipBest', args: {} , why: 'gear up' });
  return steps;
}
