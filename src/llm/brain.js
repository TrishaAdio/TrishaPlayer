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
    this._spec = null;
    this.specStats = { made: 0, used: 0, stale: 0 };
    this._creeperTried = new Map();
  }

  /**
   * Creepers she has already had a go at.
   *
   * Without this she re-engaged the same surviving creeper every few seconds —
   * observed live as five consecutive bow attempts over forty seconds while the
   * creeper simply walked around. One attempt, then leave it alone and get back to
   * work; the dodge reflex keeps her safe regardless.
   */
  recentlyTriedCreeper(id) {
    const t = this._creeperTried.get(id);
    if (!t) return false;
    if (Date.now() - t > 25000) {
      this._creeperTried.delete(id);
      return false;
    }
    return true;
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
    // Anything he says invalidates whatever she was planning to do next.
    this._spec = null;
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
      if (threat.name === 'creeper' && threat.entity?.id != null) {
        this._creeperTried.set(threat.entity.id, Date.now());
      }
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

  /**
   * A coarse fingerprint of her situation.
   *
   * Deliberately lossy: HP and food are bucketed and only the shape of the world is
   * captured. A speculative decision should stay valid while she finishes chopping a
   * tree, and an exact signature would invalidate on every single tick of damage or
   * hunger, making both the cache and the speculation useless.
   */
  stateKey() {
    const bot = this.bot;
    const hp = Math.floor((bot.health ?? 20) / 5);
    const food = Math.floor((bot.food ?? 20) / 5);
    const threats = Math.min(3, this.targeting.pick({ maxDistance: 12 }) ? 1 : 0);
    const rung = this.ladderDone ? 'done' : currentRung(bot, this.ctx())?.id || 'done';
    const t = bot.time?.timeOfDay ?? 0;
    const night = t > 13000 && t < 23000 ? 'n' : 'd';
    const dim = (bot.game?.dimension || 'ow').replace('minecraft:', '').slice(0, 3);
    const gear = `${bot.heldItem?.name || 'none'}:${[5, 6, 7, 8].filter((i) => bot.inventory.slots[i]).length}`;
    return `${rung}|${hp}|${food}|${threats}|${night}|${dim}|${gear}`;
  }

  /**
   * SPECULATIVE PLANNING.
   *
   * The brain used to sit idle while an action ran, then stall for 2-8 seconds
   * deciding what to do next — so every long job ended with a visible pause where
   * she just stood there. Now the next decision is computed *during* the current
   * action, and is waiting the instant it finishes.
   *
   * The state key guards correctness: a speculation computed for a situation that
   * no longer applies is thrown away rather than acted on.
   */
  speculate() {
    if (this._spec || this.thinking || !config.brain.autonomy) return;
    if (Date.now() - this.lastLlmAt < config.brain.thinkIntervalMs) return;

    const key = this.stateKey();
    this._spec = { key, startedAt: Date.now(), action: null, pending: true };

    this.think({ tier: 'fast', apply: false })
      .then((action) => {
        if (this._spec && this._spec.key === key) {
          this._spec.action = action;
          this._spec.pending = false;
          if (action) {
            this.specStats.made++;
            log.debug(`speculated ${action.name} for [${key}]`);
          }
        }
      })
      .catch(() => {
        this._spec = null;
      });
  }

  /** Use a speculation only if the world still looks the way it did when planned. */
  takeSpeculation() {
    if (!this._spec || this._spec.pending || !this._spec.action) return null;
    const spec = this._spec;
    const fresh = this.stateKey() === spec.key && Date.now() - spec.startedAt < 45000;
    this._spec = null;
    if (!fresh) {
      this.specStats.stale++;
      log.debug('discarded a stale speculation');
      return null;
    }
    this.specStats.used++;
    return spec.action;
  }

  async step() {
    const bot = this.bot;
    if (this.paused || !bot.entity || bot.health == null) return;
    if (this.executor.busy) {
      // Think ahead while her hands are busy, so the next decision costs no wait.
      if (!this.plan.length && !this.order) this.speculate();
      return;
    }
    if (this.thinking && !this._spec) return;

    /**
     * 1. Only genuinely life-threatening emergencies outrank RAREAURA.
     *
     * This used to be the whole emergency set, and it starved his orders: at 8 HP
     * she entered a heal loop, and "come here" sat in the queue behind it for forty
     * seconds while she stood still. Healing is important; it is not more important
     * than answering the person she is here for.
     */
    const critical = this.criticalEmergency();
    if (critical && this.allowCritical(critical)) {
      log.brain(`critical: ${critical.name}`);
      await this.executor.run(critical);
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

    // 3. Housekeeping that matters but can wait for his orders to finish.
    const soft = this.softEmergency();
    if (soft) {
      log.brain(`housekeeping: ${soft.name}`);
      await this.executor.run(soft);
      return;
    }

    // 4. The ladder — deterministic, free.
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

    // A decision that was computed while she was working is free — take it now.
    const speculated = this.takeSpeculation();
    if (speculated) {
      log.brain(`using pre-planned ${speculated.name} (no wait)`);
      this.plan.push(speculated);
      return;
    }

    if (this.thinking) return;
    if (Date.now() - this.lastLlmAt < config.brain.thinkIntervalMs) return;
    await this.think({ tier: 'fast' });
  }

  /**
   * ANTI-THRASH GATE.
   *
   * A critical action that fails to change the condition that triggered it will be
   * re-selected forever, and because criticals outrank everything she stops playing
   * entirely. Seen live: `retreat` succeeding instantly and re-firing every second,
   * and `heal` looping at 1 HP with nothing to eat.
   *
   * So an emergency that repeats without effect gets muted for a while, letting the
   * ladder or the brain try something that might actually work.
   */
  allowCritical(action) {
    const now = Date.now();
    this._critGate = this._critGate || new Map();
    const g = this._critGate.get(action.name) || { count: 0, first: now, mutedUntil: 0 };

    if (now < g.mutedUntil) return false;
    if (now - g.first > 20000) {
      g.count = 0;
      g.first = now;
    }
    g.count++;

    if (g.count > 4) {
      g.mutedUntil = now + 25000;
      g.count = 0;
      g.first = now;
      this._critGate.set(action.name, g);
      log.warn(`${action.name} kept firing without fixing anything — muting it for 25s`);
      return false;
    }
    this._critGate.set(action.name, g);
    return true;
  }

  /** About to die. These override everything, including his orders. */
  criticalEmergency() {
    const bot = this.bot;
    const hp = bot.health;
    const hostiles = this.targeting.pick({ maxDistance: 12 });

    if (hp <= config.ladder.homeHp && hostiles) return { name: 'retreat', args: {} };
    if (bot.food <= 4 && !this.reflex.bestFood(true)) return { name: 'getFood', args: { urgent: true, count: 4 } };

    /**
     * Near-death healing outranks his orders, but only just barely.
     *
     * Moving heal out of the critical tier fixed order starvation, and then a live
     * run had her walk 50 blocks to him on 1 HP because nothing stopped her. Both
     * extremes are wrong. Four hearts is the line: below it she patches herself up
     * first, above it she does what he asked.
     */
    if (hp <= 4) {
      // Healing is only an answer if she has something to heal WITH. Natural
      // regeneration needs a full food bar, so with an empty pack "heal" is a
      // dead end — observed live as an endless heal loop at 1 HP with 9 food and
      // no items. Get food first; that is what actually raises health.
      const canHeal =
        !!this.reflex.bestFood(true) ||
        bot.inventory.items().some((i) => /golden_apple|^potion$/.test(i.name));
      return canHeal ? { name: 'heal', args: {} } : { name: 'getFood', args: { urgent: true, count: 4 } };
    }

    // A creeper she cannot shoot is a reason to leave, not to fight.
    const creeper = nearbyEntities(bot, 7).find((e) => e.name === 'creeper');
    if (creeper && creeper.distance < 6) {
      const canShoot =
        bot.inventory.items().some((i) => i.name === 'bow' || i.name === 'crossbow') &&
        bot.inventory.items().some((i) => /arrow/.test(i.name));
      if (!canShoot) return { name: 'flee', args: { from: 'creeper', distance: 14 } };
    }

    // Someone hitting RAREAURA is a critical emergency. This is the one thing she
    // will drop an order for, because the order was almost certainly not
    // "let that guy keep hitting me".
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
    return null;
  }

  /** Worth doing, but never at the cost of ignoring him. */
  softEmergency() {
    const bot = this.bot;
    const hp = bot.health;
    const hostiles = this.targeting.pick({ maxDistance: 12 });

    if (hp < 12 && !hostiles) return { name: 'heal', args: {} };

    // SELF DEFENCE. Anything hostile that gets close gets dealt with, without
    // waiting for the model to have an opinion about it. Without this she stands
    // there being chewed on while the brain thinks.
    if (hp > config.ladder.homeHp) {
      const threat = this.nearestThreat();
      if (threat) {
        return { name: 'attack', args: { target: threat.username || threat.name || 'nearest' } };
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
      // Creepers: only pick a fight if she can do it from range, and only once.
      // Otherwise the reflex dodge handles them and she keeps her distance.
      if (e.name === 'creeper') {
        return hasBow && e.distance > 5 && e.distance < 10 && !this.recentlyTriedCreeper(e.entity.id);
      }
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
  async think({ tier = 'fast', stuckOn = null, apply = true } = {}) {
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
      // A speculation must not talk: it might never be acted on, and she would be
      // announcing a plan she then discards.
      if (json.say && apply) this.say(json.say);

      const action = json.action;
      if (!action?.name || !isValidAction(action.name)) {
        log.warn(`brain proposed invalid action: ${action?.name}`);
        return null;
      }
      const clean = { name: action.name, args: action.args || {} };
      if (apply) {
        log.brain(`decided ${action.name} — ${json.why || ''}`);
        this.plan.push(clean);
      }
      return clean;
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
    const sp = this.specStats;
    return (
      `llm: ${s.calls} calls, ${s.fails} fails, avg ${s.avgMs}ms | ` +
      `pre-planned: ${sp.used} used, ${sp.stale} stale | clutches: ${this.reflex.clutch.summary()}`
    );
  }
}
