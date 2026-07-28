/**
 * THE BRAIN
 *
 * Decides what to do next. Everything time-critical already happened in the reflex
 * layer before this file ever runs, so the brain is allowed to be slow (2-8s on this
 * relay) without her ever dying for it.
 *
 * Priority order, highest first:
 *   1. Reflexes            — already handled, outside this file, cannot be overridden
 *   2. RAREAURA's orders   — interrupt anything, instantly
 *   3. Emergencies         — low HP, starving, night with no shelter
 *   4. The survival ladder — deterministic, no tokens spent
 *   5. LLM judgement       — novel situations, stuck rungs, idle time
 */
import { config } from '../config.js';
import { log } from '../util/log.js';
import { mem, saveMemory } from '../world/memory.js';
import { snapshotText } from '../world/state.js';
import { completeJson, complete, llmStats } from './client.js';
import { personaCore, personaBrief, CHAT_RULES } from './persona.js';
import { actionCatalogue, isValidAction } from '../actions.js';
import { currentRung, ladderProgress } from '../progression.js';
import { fastParse, llmParse, smallTalk, addressedToHer } from '../chat/commands.js';
import { nearbyEntities } from '../world/scan.js';

export class Brain {
  constructor({ bot, reflex, combat, targeting, executor, flags }) {
    this.bot = bot;
    this.reflex = reflex;
    this.combat = combat;
    this.targeting = targeting;
    this.executor = executor;
    this.flags = flags;

    this.plan = [];           // queued actions
    this.order = null;        // what RAREAURA last told her to do
    this.running = false;
    this.paused = false;
    this.rungFailures = new Map();
    this.lastSpoke = 0;
    this.lastSaid = '';
    this.thinking = false;
    this.lastLlmAt = 0;
    this.ladderDone = false;
    this.chatQueue = [];
  }

  ctx() {
    return { bot: this.bot, memory: mem, config: config.ladder, flags: this.flags };
  }

  // ───────────────────────── speech ─────────────────────────
  say(text) {
    if (!text) return;
    let msg = String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!msg) return;
    if (msg === this.lastSaid && Date.now() - this.lastSpoke < 20000) return; // no repeating herself
    if (Date.now() - this.lastSpoke < 1200) {
      setTimeout(() => this.say(text), 1300);
      return;
    }
    this.lastSaid = msg;
    this.lastSpoke = Date.now();
    log.chat(`<${this.bot.username}> ${msg}`);
    try {
      this.bot.chat(msg);
    } catch {}
  }

  // ───────────────────────── chat in ─────────────────────────
  async onChat(username, message) {
    if (username === this.bot.username) return;
    const isOwner = username.toLowerCase() === config.owner.toLowerCase();
    const isFriend = config.friends.some((f) => f.toLowerCase() === username.toLowerCase());
    if (!addressedToHer(this.bot, username, message)) return;

    log.chat(`<${username}> ${message}`);

    // Only her people give orders.
    if (!isOwner && !isFriend) {
      const reply = await smallTalk(this.bot, username, message, this.stateText());
      this.say(reply || 'busy right now');
      return;
    }

    const fast = fastParse(this.bot, username, message);

    if (fast) {
      log.brain(`fast path: ${fast.actions.map((a) => a.name).join(' -> ') || 'talk only'}`);
      if (fast.statusQuery) {
        this.say(this.statusLine());
        return;
      }
      if (fast.stopOnly) {
        this.executor.cancel('owner said stop');
        this.plan = [];
        this.order = null;
        this.say(fast.reply);
        return;
      }
      if (fast.reply) this.say(fast.reply);
      this.acceptOrder(message, fast.actions, fast.priority === 'interrupt');
      return;
    }

    // Slow path: let the model work out what he meant.
    const parsed = await llmParse(this.bot, username, message, this.stateText());
    if (!parsed || !parsed.actions.length) {
      const reply = parsed?.reply || (await smallTalk(this.bot, username, message, this.stateText()));
      this.say(reply);
      return;
    }
    log.brain(`llm path: ${parsed.actions.map((a) => a.name).join(' -> ')}`);
    if (parsed.reply) this.say(parsed.reply);
    this.acceptOrder(message, parsed.actions, parsed.priority === 'interrupt');
  }

  acceptOrder(text, actions, interrupt = true) {
    if (!actions?.length) return;
    this.order = { text, at: Date.now(), actions: actions.map((a) => a.name) };
    if (interrupt) {
      this.executor.cancel('owner order');
      this.plan = [...actions];
    } else {
      this.plan.push(...actions);
    }
    mem.note(`order from ${config.owner}: ${text}`);
  }

  // ───────────────────────── state ─────────────────────────
  stateText(extra = {}) {
    const lp = ladderProgress(this.bot, this.ctx());
    return snapshotText(this.bot, {
      doing: this.executor.currentName || 'nothing',
      queued: this.plan.map((a) => a.name).join(' -> ') || 'nothing',
      lastOrder: this.order?.text || 'none',
      recent: this.executor.recentSummary(3) || 'nothing yet',
      ladder: `${lp.doneCount}/${lp.total} done, current: ${lp.current}`,
      clutches: this.reflex.clutch.summary(),
      ...extra,
    });
  }

  statusLine() {
    const b = this.bot;
    const p = b.entity.position;
    const doing = this.executor.currentName || this.plan[0]?.name || 'nothing much';
    const lp = ladderProgress(b, this.ctx());
    return `hp ${Math.round(b.health)}/20, food ${Math.round(b.food)}/20, at ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}, doing ${doing} (${lp.doneCount}/${lp.total})`;
  }

  // ───────────────────────── the loop ─────────────────────────
  start() {
    if (this.running) return;
    this.running = true;
    log.brain('brain online');
    this.tickLoop();
    this.defenceWatch();
  }

  /**
   * Self-defence runs on its own timer, not inside the main step loop.
   *
   * Reason: the main loop returns early while an action is running, and mining a
   * vein or chopping a tree occupies the executor for minutes. Without a separate
   * watcher she would stand there being eaten because she was "busy".
   *
   * Interrupting is safe: the ladder is predicate-based, so after the fight she
   * re-derives the correct rung by herself. An explicit order from RAREAURA is
   * preserved and resumed.
   */
  defenceWatch() {
    const INTERVAL = 700;
    this._defenceTimer = setInterval(() => {
      if (!this.running || this.paused || !this.bot.entity || this.bot.health == null) return;
      if (Date.now() - (this._lastDefence || 0) < 3000) return;
      if (this.bot.health <= config.ladder.homeHp) return; // reflex/retreat owns this
      if (this.executor.currentName === 'attack' || this.executor.currentName === 'duel' || this.executor.currentName === 'defend') return;

      const threat = this.nearestThreat();
      if (!threat) return;

      this._lastDefence = Date.now();
      const remaining = [...this.plan];
      log.brain(`self defence: ${threat.name || threat.username} at ${threat.distance}m (was ${this.executor.currentName || 'idle'})`);

      this.plan = [{ name: 'attack', args: { target: threat.username || threat.name || 'nearest' } }];
      // Keep his orders; ladder work re-derives itself.
      if (this.order) this.plan.push(...remaining);
      this.executor.cancel('defending myself');
    }, INTERVAL);
    this._defenceTimer.unref?.();
  }

  stop() {
    this.running = false;
    if (this._defenceTimer) clearInterval(this._defenceTimer);
  }

  async tickLoop() {
    while (this.running) {
      try {
        await this.step();
      } catch (err) {
        log.error(`brain step: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  async step() {
    const bot = this.bot;
    if (this.paused || !bot.entity || bot.health == null) return;
    if (this.executor.busy) return;
    if (this.thinking) return;

    // 1. Emergencies the reflex layer cannot solve on its own.
    const emergency = this.emergencyAction();
    if (emergency) {
      log.brain(`emergency: ${emergency.name}`);
      await this.executor.run(emergency);
      return;
    }

    // 2. Queued plan (from his orders, or from a ladder rung).
    if (this.plan.length) {
      const next = this.plan.shift();
      const result = await this.executor.run(next);
      if (!result.ok && !result.aborted) await this.handleFailure(next, result);
      if (!this.plan.length && this.order) {
        const done = this.order;
        this.order = null;
        this.reportDone(done, result);
      }
      return;
    }

    // 3. The ladder — deterministic, free.
    if (config.ladder.onSpawn && !this.ladderDone) {
      const rung = currentRung(bot, this.ctx());
      if (rung) {
        const fails = this.rungFailures.get(rung.id) || 0;
        if (fails >= 3) {
          // Stuck. Spend real tokens on it once, then move on.
          log.brain(`rung ${rung.id} stuck after ${fails}, escalating to ${config.llm.smart}`);
          const decision = await this.think({ tier: 'smart', stuckOn: rung });
          this.rungFailures.set(rung.id, 0);
          if (decision) return;
        }
        const actions = typeof rung.actions === 'function' ? rung.actions(bot, this.ctx()) : rung.actions;
        log.brain(`ladder: ${rung.id} — ${rung.label}`);
        this.plan.push(...actions);
        this.currentRungId = rung.id;
        return;
      }
      this.ladderDone = true;
      log.brain('ladder complete — full kit');
      this.say('geared up. what now~');
    }

    // 4. Nothing to do: let her decide for herself, but not too often.
    if (!config.brain.autonomy) return;
    if (Date.now() - this.lastLlmAt < config.brain.thinkIntervalMs) return;
    await this.think({ tier: 'fast' });
  }

  /** Things that must happen right now but need a skill, not a reflex. */
  emergencyAction() {
    const bot = this.bot;
    const hp = bot.health;
    const hostiles = this.targeting.pick({ maxDistance: 12 });

    if (hp <= config.ladder.homeHp && hostiles) return { name: 'retreat', args: {} };
    if (bot.food <= 4 && !this.reflex.bestFood(true)) return { name: 'getFood', args: { urgent: true, count: 4 } };
    if (hp < 12 && !hostiles) return { name: 'heal', args: {} };

    // A creeper she cannot shoot is a reason to leave, not to fight.
    const creeper = nearbyEntities(bot, 7).find((e) => e.name === 'creeper');
    if (creeper && creeper.distance < 6) {
      const canShoot =
        bot.inventory.items().some((i) => i.name === 'bow' || i.name === 'crossbow') &&
        bot.inventory.items().some((i) => /arrow/.test(i.name));
      if (!canShoot) return { name: 'flee', args: { from: 'creeper', distance: 14 } };
    }

    // SELF DEFENCE. Anything hostile that gets close gets dealt with, without
    // waiting for the model to have an opinion about it. Without this she stands
    // there being chewed on while the brain thinks.
    if (hp > config.ladder.homeHp) {
      const threat = this.nearestThreat();
      if (threat) {
        return { name: 'attack', args: { target: threat.username || threat.name || 'nearest' } };
      }
    }

    // Owner under attack outranks everything except her own survival.
    const owner = bot.players[config.owner]?.entity;
    if (owner && hp > 10) {
      const attacker = [...this.targeting.ownerAttackers.entries()].find(([, t]) => Date.now() - t < 8000);
      if (attacker) {
        const e = bot.entities[attacker[0]];
        if (e) {
          this.say('hands off him');
          return { name: 'attack', args: { target: e.username || e.name || 'nearest' } };
        }
      }
    }

    // Night, outside, no shelter, and things are spawning.
    const t = bot.time?.timeOfDay ?? 0;
    const isNight = t > 13000 && t < 23000;
    if (isNight && !mem.all.bed && !mem.all.shelterBuilt && this.targeting.pick({ maxDistance: 16 })) {
      return { name: 'shelter', args: {} };
    }
    return null;
  }

  /**
   * Something worth swinging at right now.
   * Creepers are deliberately left to the reflex layer until they are far enough
   * away to trade hits safely — walking up to a creeper is how bots explode.
   */
  nearestThreat() {
    const bot = this.bot;
    const hasBow =
      bot.inventory.items().some((i) => i.name === 'bow' || i.name === 'crossbow') &&
      bot.inventory.items().some((i) => /arrow/.test(i.name));

    const candidates = nearbyEntities(bot, 10).filter((e) => {
      if (!e.isHostile) return false;
      // Creepers: only pick a fight if she can do it from range. Otherwise the
      // reflex dodge handles them and she keeps her distance.
      if (e.name === 'creeper') return hasBow && e.distance > 5 && e.distance < 10;
      if (e.name === 'warden') return false; // nobody fights a warden. she leaves.
      if (/skeleton|stray|bogged|pillager|witch|blaze/.test(e.name)) return e.distance < 10;
      return e.distance < 7;
    });
    if (!candidates.length) return null;
    // Reuse the full threat scoring so priorities and pvp policy still apply.
    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
      const s = this.targeting.score(c);
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    return best;
  }

  async handleFailure(action, result) {
    const rungId = this.currentRungId;
    if (rungId) this.rungFailures.set(rungId, (this.rungFailures.get(rungId) || 0) + 1);
    log.brain(`${action.name} failed: ${result.reason}`);

    // A failed step invalidates the rest of a stale plan.
    if (/need |no such|not craftable|no fuel|no chest|no bed/.test(result.reason || '')) {
      this.plan = [];
      if (this.order) {
        this.say(this.shortExcuse(result.reason));
        this.order = null;
      }
    }
  }

  shortExcuse(reason) {
    const r = String(reason || '').toLowerCase();
    if (r.includes('need ')) return `cant, i ${r}`;
    if (r.includes('no fuel')) return 'no fuel for the furnace';
    if (r.includes('cannot see')) return 'cant see you';
    if (r.includes('no chest')) return 'no chest around';
    if (r.includes('cannot reach')) return 'cant get there';
    return "that didnt work";
  }

  reportDone(order, result) {
    if (!order) return;
    const good = result?.ok !== false;
    const detail = result?.detail ? ` (${result.detail})` : '';
    log.brain(`order finished: ${order.text}${detail}`);
    if (good) {
      const lines = ['done~', 'all done', 'got it', 'finished', 'done, anything else?'];
      this.say(result?.detail && result.detail.length < 60 ? `done — ${result.detail}` : lines[Math.floor(Math.random() * lines.length)]);
    }
  }

  /**
   * Ask the model what to do. Strict JSON, validated against the registry;
   * anything invalid becomes feedback rather than a crash.
   */
  async think({ tier = 'fast', stuckOn = null } = {}) {
    if (this.thinking) return null;
    this.thinking = true;
    this.lastLlmAt = Date.now();

    const system = `${personaCore()}

You are choosing your own next action in Minecraft. You are not assisting anyone — you are playing.

Available actions:
${actionCatalogue()}

Reply with ONLY this JSON:
{"say": "short chat line or null", "action": {"name":"...","args":{}}, "why": "brief", "remember": "a durable lesson, or null"}

Rules:
- Exactly one action, using an exact name from the list above.
- Prefer being useful and self-sufficient: gear up, secure food, mine, build, improve the base.
- Do not spam chat. "say" should usually be null unless something is worth saying.
- Your reflexes already handle eating, dodging and clutching. Do not waste an action on them.`;

    const extra = stuckOn
      ? { stuck: `You have failed the objective "${stuckOn.label}" several times. Choose a different approach.` }
      : {};

    try {
      const json = await completeJson({
        tier,
        system,
        messages: [{ role: 'user', content: this.stateText(extra) }],
        maxTokens: 500,
        temperature: 0.5,
      });
      if (!json) {
        log.warn('brain got no usable JSON');
        return null;
      }

      if (json.remember) mem.addLesson(json.remember);
      if (json.say) this.say(json.say);

      const action = json.action;
      if (!action?.name || !isValidAction(action.name)) {
        log.warn(`brain proposed invalid action: ${action?.name}`);
        return null;
      }
      log.brain(`decided ${action.name} — ${json.why || ''}`);
      this.plan.push({ name: action.name, args: action.args || {} });
      return action;
    } catch (err) {
      log.warn(`think failed: ${err.message}`);
      return null;
    } finally {
      this.thinking = false;
    }
  }

  // ───────────────────────── events ─────────────────────────
  onDeath() {
    const pos = this.bot.entity?.position;
    const cause = this.guessDeathCause();
    mem.recordDeath(cause, pos);
    mem.addLesson(`died to ${cause} at Y=${pos ? Math.round(pos.y) : '?'} — be more careful there`);
    saveMemory(true);
    this.plan = [];
    this.order = null;
    this.executor.cancel('died');
    this.flags.returnedHome = false;
    const lines = ['ugh, i died', 'that hurt...', 'i died, coming back', 'ow. going to get my stuff'];
    setTimeout(() => this.say(lines[Math.floor(Math.random() * lines.length)]), 1200);
  }

  guessDeathCause() {
    const last = this.executor.history[0];
    const threats = this.targeting.pick({ maxDistance: 10 });
    if (threats) return threats.username || threats.name || 'a mob';
    if (last?.name === 'branchMine' || last?.name === 'digDown') return 'something underground';
    return 'unknown';
  }

  onSpawn() {
    this.flags.returnedHome = false;
    this.rungFailures.clear();
    if (!mem.all.base) mem.setBase(this.bot.entity.position, 'spawn');
  }

  statsLine() {
    const s = llmStats();
    return `llm: ${s.calls} calls, ${s.fails} fails, avg ${s.avgMs}ms | clutches: ${this.reflex.clutch.summary()}`;
  }
}
