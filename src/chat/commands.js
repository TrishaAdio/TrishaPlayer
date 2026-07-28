/**
 * Understanding RAREAURA.
 *
 * Two paths, on purpose:
 *
 *   FAST PATH  — regex match on the couple of dozen things he actually says.
 *                Zero latency. "trisha come here" must move her THIS INSTANT, not
 *                five seconds later when a model finishes thinking.
 *
 *   SLOW PATH  — anything unrecognised goes to the LLM, which maps it onto the
 *                action catalogue. Slower, but handles whatever he invents.
 *
 * Both produce the same thing: a list of actions plus something for her to say.
 */
import { config } from '../config.js';
import { log } from '../util/log.js';
import { complete, completeJson } from '../llm/client.js';
import { personaBrief, CHAT_RULES } from '../llm/persona.js';
import { actionCatalogue, isValidAction } from '../actions.js';

const OWNER = () => config.owner.toLowerCase();

/** Does this message even want her attention? */
export function addressedToHer(bot, username, message) {
  const m = message.toLowerCase();
  const name = bot.username.toLowerCase();
  if (m.startsWith(name) || m.includes(`@${name}`)) return true;
  if (new RegExp(`\\b${name}\\b`).test(m)) return true;
  // Direct short commands from the owner alone need no name.
  if (username.toLowerCase() === OWNER()) {
    return /^(come|come here|cmere|here|stop|wait|follow|follow me|attack|kill it|help|guard me|protect me|hi|hey|hello|home|sleep|status|hp|inv|inventory|food|heal|thanks|ty|gg|lets go|let's go)\b/i.test(m.trim());
  }
  return false;
}

/** Strip her name and filler so the intent is clean. */
function normalise(bot, message) {
  let m = message.toLowerCase().trim();
  const name = bot.username.toLowerCase();
  m = m.replace(new RegExp(`^@?${name}[,:\\s]+`, 'i'), '');
  m = m.replace(new RegExp(`\\b@?${name}\\b`, 'gi'), '');
  m = m.replace(/^(hey|yo|oi|pls|please|can you|could you|would you|go|now)\s+/gi, '');
  m = m.replace(/\s+/g, ' ').trim();
  return m;
}

const A = (name, args = {}) => ({ name, args });

/**
 * FAST PATH. Ordered — first match wins, so specific patterns come before general.
 * Every entry returns { actions, reply, priority }.
 */
const RULES = [
  // stop / hold
  {
    re: /^(stop|wait|halt|stay|hold on|chill|freeze|cancel|nvm|never mind)\b/,
    build: () => ({ actions: [A('stop')], reply: 'ok, stopping', priority: 'interrupt', stopOnly: true }),
  },
  // come to me
  {
    re: /\b(come here|come|cmere|c'mere|get over here|to me|over here|this way|follow me here)\b/,
    build: () => ({ actions: [A('come', { range: 2 })], reply: 'coming!', priority: 'interrupt' }),
  },
  // follow
  {
    re: /\b(follow me|follow|stick with me|come with me|lets go|let's go)\b(?!.*\battack|kill|fight\b)/,
    build: () => ({ actions: [A('follow', { player: config.owner, distance: 3 })], reply: 'right behind you', priority: 'interrupt' }),
  },
  // defend / protect
  {
    re: /\b(protect me|guard me|defend me|watch my back|cover me|help me)\b/,
    build: () => ({ actions: [A('defend', { player: config.owner, seconds: 120 })], reply: 'nobody touches you', priority: 'interrupt' }),
  },
  // attack — "lets go attack", "kill that zombie", "attack RAREAURA2"
  {
    re: /\b(attack|kill|fight|kys|destroy|hit|smack)\b\s*(?<target>[a-z0-9_]+)?/,
    build: (m) => {
      const t = m.groups?.target;
      const skip = ['it', 'that', 'them', 'this', 'him', 'her', 'him', 'the', 'a', 'everything', 'all'];
      const target = !t || skip.includes(t) ? 'nearest' : t;
      return { actions: [A('attack', { target })], reply: target === 'nearest' ? 'on it' : `going for ${target}`, priority: 'interrupt' };
    },
  },
  {
    re: /\b(lets go|let's go|come on)\b.*\b(attack|fight|kill|hunt|raid)\b/,
    build: () => ({ actions: [A('attack', { target: 'nearest' })], reply: 'lets go!!', priority: 'interrupt' }),
  },
  // give — sits above the resource rules on purpose. "gimme 3 diamonds" means hand
  // them over, not go on a mining expedition. Same for "give me food" vs "get us food".
  {
    re: /\b(give me|hand me|pass me|drop me|gimme|can i have|i need)\b\s*(?<count>\d+)?\s*(?<item>[a-z_ ]+)?/,
    build: (m, ctx) => {
      let item = (m.groups?.item || 'food').trim().replace(/\s+/g, '_') || 'food';
      item = item.replace(/s$/, '').replace(/^some_/, '');
      const count = Number(m.groups?.count) || 1;
      const actions = [];
      // Only go and fetch if she is actually empty-handed.
      const isFood = /food|meat|bread|apple|steak/.test(item);
      const has = ctx.bot?.inventory?.items
        ? ctx.bot.inventory.items().some((i) => (isFood ? /cooked_|bread|baked_potato|apple|melon/.test(i.name) : i.name.includes(item)))
        : true;
      if (!has && isFood) actions.push(A('getFood', { count: Math.max(6, count) }));
      actions.push(A('come', { range: 2 }), A('give', { player: config.owner, item: isFood ? 'food' : item, count }));
      return { actions, reply: `here, ${item.replace(/_/g, ' ')}`, priority: 'interrupt' };
    },
  },
  // diamonds
  {
    re: /\b(diamonds?|diamond)\b/,
    build: () => ({
      actions: [A('equipBest'), A('branchMine', { targetY: config.ladder.diamondY, ore: 'diamond_ore', count: 8, lavaCaution: true }), A('home'), A('deposit', { keep: 'gear,food,torch,blocks' })],
      reply: 'diamond run, back soon~',
    }),
  },
  // iron
  {
    re: /\b(iron)\b/,
    build: () => ({
      actions: [A('branchMine', { targetY: config.ladder.ironY, ore: 'iron_ore', count: 24 }), A('smelt', { item: 'iron_ingot', count: 24 }), A('equipBest')],
      reply: 'getting iron',
    }),
  },
  // food — "get us food", "get us foods", "im hungry", "feed us"
  {
    re: /\b(foods?|hungry|starving|eat|feed|meat|something to eat)\b/,
    build: (m, ctx) => {
      const forHim = /\b(us|me|my|our|feed)\b/.test(ctx.raw);
      const actions = [A('getFood', { count: 10 })];
      if (forHim) actions.push(A('come', { range: 2 }), A('give', { player: config.owner, item: 'food', count: 5 }));
      return { actions, reply: forHim ? 'getting food for us~' : 'stocking up on food' };
    },
  },
  // base / house
  {
    re: /\b(base|house|home base|shelter for us|build us|build a|make a base|build)\b/,
    build: (m, ctx) => {
      if (/\bshelter\b/.test(ctx.raw)) return { actions: [A('shelter')], reply: 'digging in' };
      const size = Number((ctx.raw.match(/(\d+)\s*x/) || [])[1]) || 7;
      return { actions: [A('base', { size })], reply: 'building us a place~' };
    },
  },
  { re: /\bshelter\b/, build: () => ({ actions: [A('shelter')], reply: 'making a shelter' }) },
  // home
  {
    re: /\b(go home|head home|back to base|home)\b/,
    build: () => ({ actions: [A('home')], reply: 'heading home' }),
  },
  // sleep
  { re: /\b(sleep|bed|goodnight|good night)\b/, build: () => ({ actions: [A('sleep')], reply: 'night~' }) },
  // wood / stone / generic mining
  {
    re: /\b(wood|logs?|trees?)\b/,
    build: () => ({ actions: [A('chopWood', { count: 16 })], reply: 'chopping wood' }),
  },
  {
    re: /\bmine\b\s*(?<count>\d+)?\s*(?<block>[a-z_]+)?/,
    build: (m) => {
      const block = m.groups?.block || 'stone';
      const count = Number(m.groups?.count) || 16;
      return { actions: [A('mine', { block, count })], reply: `mining ${block}` };
    },
  },
  // gear
  { re: /\b(gear up|equip|armor|armour|wear)\b/, build: () => ({ actions: [A('equipBest')], reply: 'geared' }) },
  // storage
  { re: /\b(deposit|store|stash|put away|dump)\b/, build: () => ({ actions: [A('deposit', {})], reply: 'storing it' }) },
  // light
  { re: /\b(torch|light|lights|light up)\b/, build: () => ({ actions: [A('lightArea', { radius: 10 })], reply: 'lighting it up' }) },
  // farm
  { re: /\b(farm|wheat|crops|plant)\b/, build: () => ({ actions: [A('farmCrops', { crop: 'wheat', plots: 16 })], reply: 'starting a farm' }) },
  { re: /\b(harvest)\b/, build: () => ({ actions: [A('harvest', {})], reply: 'harvesting' }) },
  { re: /\b(fish|fishing)\b/, build: () => ({ actions: [A('fish', { count: 6 })], reply: 'fishing~' }) },
  // heal / retreat
  { re: /\b(heal|health|hp low|run|retreat|get out)\b/, build: () => ({ actions: [A('retreat')], reply: 'pulling back', priority: 'interrupt' }) },
  // explore
  { re: /\b(explore|scout|look around|find)\b/, build: () => ({ actions: [A('explore', { radius: 100 })], reply: 'scouting' }) },
  // status queries — no action, just an answer
  {
    re: /\b(status|what are you doing|wyd|hp|health|inv|inventory|where are you|report)\b/,
    build: () => ({ actions: [], reply: null, statusQuery: true }),
  },
];

/** Try the instant path. Returns null if nothing matched. */
export function fastParse(bot, username, message) {
  const raw = normalise(bot, message);
  if (!raw) return null;
  for (const rule of RULES) {
    const m = raw.match(rule.re);
    if (m) {
      const out = rule.build(m, { raw, username, bot });
      if (out) return { ...out, matched: rule.re.source, raw };
    }
  }
  return null;
}

/** Anything the fast path missed goes to the model. */
export async function llmParse(bot, username, message, stateText) {
  const system = `${personaBrief()}

You convert what your player says into actions you can physically perform in Minecraft.

Available actions:
${actionCatalogue()}

Reply with ONLY JSON:
{"reply": "short chat line as Trisha, or null", "actions": [{"name":"...","args":{}}], "interrupt": true|false}

Rules:
- 1 to 4 actions, in the order they should happen.
- Use exact action names from the list. Never invent one.
- "interrupt": true if this should abandon what you are currently doing.
- If he is only chatting, return an empty actions array and just reply.`;

  const user = `He said: "${message}"

Your current situation:
${stateText}`;

  try {
    const json = await completeJson({
      tier: 'fast',
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 500,
      temperature: 0.4,
    });
    if (!json) return null;

    const actions = (Array.isArray(json.actions) ? json.actions : [])
      .filter((a) => a && isValidAction(a.name))
      .slice(0, 4)
      .map((a) => ({ name: a.name, args: a.args && typeof a.args === 'object' ? a.args : {} }));

    return {
      actions,
      reply: typeof json.reply === 'string' ? json.reply.slice(0, 200) : null,
      priority: json.interrupt === false ? 'queue' : 'interrupt',
      raw: message,
    };
  } catch (err) {
    log.warn(`chat parse failed: ${err.message}`);
    return null;
  }
}

/** Pure conversation — no action, just her voice. */
export async function smallTalk(bot, username, message, stateText) {
  try {
    const text = await complete({
      tier: 'chat',
      system: `${personaBrief()}\n\n${CHAT_RULES}`,
      messages: [
        { role: 'user', content: `${username} says: "${message}"\n\nYour situation right now:\n${stateText}` },
      ],
      maxTokens: 300,
      temperature: 0.8,
    });
    return text.trim().replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 200);
  } catch {
    return null;
  }
}
