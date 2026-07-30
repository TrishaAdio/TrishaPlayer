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
import { fastParse, llmParse, smallTalk, addressedToHer, looksLikeQuestion } from '../chat/commands.js';
import { nearbyEntities } from '../world/scan.js';
import { makePlan, fallbackPlan } from './planner.js';

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
    let msg = String(text).replace(/\s+/g, ' ').trim();

    /**
     * Strip emoji. The persona forbids them, but the chat model kept adding hearts
     * anyway — and on a live server she greeted RAREAURA with "hey babe! missed you"
     * three times in a row, each with a different heart, so the repeat filter did not
     * catch any of them.
     */
    msg = msg
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2764}\u{1F000}-\u{1F0FF}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    if (!msg) return;

    // Compare on a normalised form so punctuation and emoji cannot smuggle a
    // duplicate past the filter.
    const key = msg.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (key === this._lastSaidKey && Date.now() - this.lastSpoke < 25000) return;
    this._lastSaidKey = key;
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
      if (fast.greeting) {
        // Answer warmly, do not go anywhere.
        const reply = await smallTalk(this.bot, username, message, this.stateText());
        this.say(reply || 'hey you');
        return;
      }
      if (fast.ambient) {
        /**
         * "Grind" means use your judgement — so re-survey and plan properly, rather
         * than improvising four actions that discard the plan she already made.
         */
        log.brain('ambient order — surveying and planning fresh');
        this.sessionPlan = null;
        this._lastPlanAt = 0;
        this._planReason = `${config.owner} told you to "${message.slice(0, 60)}" — decide for yourself and commit to it`;
        this.plan = [];
        this.order = null;
        this.holdUntil = 0;
        this.say('on it, lemme look around first');
        return;
      }
      if (fast.stopOnly) {
        /**
         * "Stop" has to mean stop.
         *
         * Cancelling the action was not enough: the ladder immediately queued the next
         * job and she walked off again, so a live test measured her moving 5.1m in the
         * four seconds after being told to stop. She now holds position until he says
         * something else, or two minutes pass.
         */
        this.executor.cancel('owner said stop');
        this.plan = [];
        this.order = null;
        this._spec = null;
        this.holdUntil = Date.now() + 120000;
        this.say(fast.reply);
        return;
      }
      if (fast.reply) this.say(fast.reply);
      this.acceptOrder(message, fast.actions, fast.priority === 'interrupt');
      return;
    }

    // A question deserves an answer, not a work order.
    if (looksLikeQuestion(message)) {
      const reply = await smallTalk(this.bot, username, message, this.stateText());
      this.say(reply || 'not sure');
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

  /**
   * TASK COMMITMENT.
   *
   * "i dont know the point what she even wanna do ... random running, do chops, still
   * again running." That was not one bug, it was the absence of commitment: every new
   * thought replaced the last, so she started ten things and finished none.
   *
   * A plan now gets a minimum window to actually run. RAREAURA can always override —
   * he is the whole point — and so can a critical emergency. Only her own second
   * thoughts are made to wait.
   */
  committed() {
    if (!this._commitUntil) return false;
    if (Date.now() > this._commitUntil) {
      this._commitUntil = 0;
      return false;
    }
    return true;
  }

  commit(ms) {
    this._commitUntil = Date.now() + ms;
  }

  acceptOrder(text, actions, interrupt = true) {
    if (!actions?.length) return;
    // Anything he says invalidates whatever she was planning to do next, and
    // releases a hold from a previous "stop".
    this._spec = null;
    this.holdUntil = 0;
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
    this.stuckWatch();
  }

  /**
   * STUCK WATCHDOG.
   *
   * Observed live: "she stucks sometime cant do anything stands". An action can hang
   * without failing — pathfinder quietly gives up, a dig target becomes unreachable,
   * a goal is never satisfied — and because the executor still counts as busy, the
   * brain politely waits forever and she just stands there.
   *
   * So: watch her actual position. If she has not moved and the same action has been
   * running for a while, treat it as hung. Physically unstick first (jump, sidestep,
   * dig out if she is walled in), then cancel so the ladder or the brain can choose
   * something new.
   */
  stuckWatch() {
    const CHECK_MS = 4000;
    const IDLE_AFTER = 20000;    // nothing running, nothing queued

    /**
     * PER-ACTION TIME BUDGETS.
     *
     * A single global threshold was wrong and actively harmful. Chopping trees means
     * walking between them, and a run legitimately goes a minute without a block
     * breaking — so a 28-second budget killed it, the ladder restarted it from zero,
     * and she looped forever while crafting failed for want of the wood she kept not
     * collecting. Observed live as chopWood being cancelled twice in ninety seconds.
     *
     * Budgets are generous for anything that travels, and tight only for things that
     * should be instant.
     */
    const BUDGET = {
      // travel and gathering: minutes are normal
      chopWood: 90000, mine: 60000, branchMine: 180000, collectDrops: 45000,
      explore: 90000, goto: 90000, come: 90000, home: 120000, follow: 999999,
      getFood: 120000, forageFood: 120000, butcher: 90000, getWool: 90000,
      farmCrops: 90000, harvest: 90000, digDown: 120000, netherRun: 600000,
      xpGrind: 180000, base: 120000, shelter: 90000, bridge: 90000,
      // stationary but productive
      craft: 45000, smelt: 120000, deposit: 45000, withdraw: 45000, enchant: 60000,
      bookshelves: 120000, upgradeNetherite: 60000, placeBed: 45000,
      // fights end or they do not
      attack: 90000, duel: 120000, hunt: 180000, defend: 999999, kite: 90000,
      // truly instant
      equipBest: 15000, placeBlock: 20000, lightArea: 60000, markHome: 10000,
      say: 5000, idle: 999999, sleep: 999999, fish: 999999, heal: 60000,
    };
    const DEFAULT_BUDGET = 60000;

    this._lastPos = null;
    this._stillSince = Date.now();
    this._idleSince = Date.now();

    this._stuckTimer = setInterval(async () => {
      if (!this.running || this.paused || !this.bot.entity) return;
      const now = Date.now();
      const pos = this.bot.entity.position;

      /**
       * Progress, not just movement.
       *
       * Watching position alone produced a false positive that cancelled a legitimate
       * shelter build: "stuck: shelter has run 28s without moving" — of course it was
       * not moving, it was placing blocks around her. Mining, crafting, smelting,
       * fishing and building are all productive while stationary. So the signature
       * includes what she has done, not only where she is.
       */
      const sig = [
        Math.round(pos.x), Math.round(pos.y), Math.round(pos.z),
        mem.stats.blocksMined, mem.stats.itemsCrafted, mem.stats.kills,
        this.bot.inventory.items().reduce((n, i) => n + i.count, 0),
        Math.round(this.bot.health ?? 0),
      ].join(',');

      const progressed = sig !== this._lastSig;
      this._lastSig = sig;
      if (progressed) this._stillSince = now;

      // Remember where he was last seen, so "come here" still works after he walks
      // out of entity range. Without this she simply answers "cant see you".
      const owner = this.bot.players[config.owner]?.entity;
      if (owner?.position) {
        mem.set('ownerLastSeen', {
          x: Math.round(owner.position.x),
          y: Math.round(owner.position.y),
          z: Math.round(owner.position.z),
          at: now,
        });
      }

      const busy = this.executor.busy;
      const holding = this.holdUntil && now < this.holdUntil;
      if (holding) return; // she was told to stand still; standing still is correct

      // Case 1: an action is running but she is frozen in place.
      if (busy) {
        const name = this.executor.currentName;
        const budget = BUDGET[name] ?? DEFAULT_BUDGET;
        const idleFor = now - this._stillSince;

        if (idleFor > budget) {
          log.warn(`stuck: ${name} made no progress for ${Math.round(idleFor / 1000)}s (budget ${Math.round(budget / 1000)}s) — unsticking`);
          await this.unstick().catch(() => {});
          this.executor.cancel('stuck');
          this._stillSince = now;
          this._spec = null;

          /**
           * Do not let the ladder immediately re-run the thing that just hung. Count
           * it against the rung so that after a couple of attempts the rung escalates
           * or is skipped, instead of cycling forever.
           */
          if (this.currentRungId) {
            this.rungFailures.set(this.currentRungId, (this.rungFailures.get(this.currentRungId) || 0) + 1);
          }
          this._stuckCounts = this._stuckCounts || new Map();
          const n = (this._stuckCounts.get(name) || 0) + 1;
          this._stuckCounts.set(name, n);
          if (n >= 3) {
            log.warn(`${name} has hung ${n} times — leaving it alone for a while`);
            this.plan = this.plan.filter((a) => a.name !== name);
          }
        }
        return;
      }

      // Case 2: nothing running, nothing queued, and no one is talking to her.
      if (!busy && !this.plan.length) {
        if (now - this._idleSince > IDLE_AFTER) {
          this._idleSince = now;
          // In stability mode standing still IS the job — waiting for orders is not a
          // fault, so do not nag about it every twenty seconds.
          if (!config.ladder.onSpawn && !config.brain.autonomy) return;
          if (!this.ladderDone) {
            log.warn('idle with an empty queue — forcing a ladder re-evaluation');
            this.rungFailures.clear();
          } else {
            this.think({ tier: 'fast' }).catch(() => {});
          }
        }
      } else {
        this._idleSince = now;
      }
    }, CHECK_MS);
    this._stuckTimer.unref?.();
  }

  /** Physically get her moving again: jump, sidestep, and dig out if enclosed. */
  async unstick() {
    const bot = this.bot;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      bot.pathfinder.setGoal(null);
    } catch {}
    for (const c of ['forward', 'back', 'left', 'right', 'sprint']) bot.setControlState(c, false);

    // Walled in? Dig the block in front of her face rather than shoving at it.
    const eye = bot.entity.position.offset(0, 1, 0);
    const yaw = bot.entity.yaw;
    const ahead = eye.offset(-Math.sin(yaw), 0, -Math.cos(yaw)).floored();
    const block = bot.blockAt(ahead);
    if (block && block.boundingBox === 'block' && !/bedrock|water|lava/.test(block.name)) {
      const { digBlock } = await import('../skills/gather.js');
      const { Task } = await import('../task.js');
      await digBlock(bot, new Task('unstick'), block, { safety: true }).catch(() => {});
    }

    bot.setControlState('jump', true);
    bot.setControlState('forward', true);
    await wait(500);
    bot.setControlState('jump', false);
    // Sidestep, because "forward" is often exactly the direction that is blocked.
    bot.setControlState(Math.random() < 0.5 ? 'left' : 'right', true);
    await wait(500);
    for (const c of ['forward', 'left', 'right']) bot.setControlState(c, false);
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

      /**
       * Creepers must be able to interrupt her work.
       *
       * The dodge reflex is tick-based so it always fired, but it only backs her off
       * for a moment — and because a creeper she cannot shoot is excluded from
       * nearestThreat, nothing ever interrupted the job she was doing. She would keep
       * chopping in the same spot, dodge, drift back, dodge again, and eventually one
       * caught her. A soak run ended exactly that way. Now she leaves the area.
       */
      const creeper = nearbyEntities(this.bot, 6).find((e) => e.name === 'creeper');
      if (creeper) {
        const canShoot =
          this.bot.inventory.items().some((i) => i.name === 'bow' || i.name === 'crossbow') &&
          this.bot.inventory.items().some((i) => /arrow/.test(i.name));
        if (!canShoot && !this.recentlyTriedCreeper(creeper.entity.id)) {
          this._lastDefence = Date.now();
          this._creeperTried.set(creeper.entity.id, Date.now());
          const remaining = [...this.plan];
          log.brain(`creeper at ${creeper.distance}m and no bow — leaving the area`);
          this.plan = [{ name: 'flee', args: { from: 'creeper', distance: 16 } }];
          if (this.order) this.plan.push(...remaining);
          this.executor.cancel('creeper too close');
          return;
        }
      }

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
    if (this._stuckTimer) clearInterval(this._stuckTimer);
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

    // Told to stand down. Survival still applies — everything else waits.
    if (this.holdUntil && Date.now() < this.holdUntil) {
      if (!this._heldLogged) {
        log.brain('holding position until told otherwise');
        this._heldLogged = true;
      }
      return;
    }
    this._heldLogged = false;

    // 2. Queued plan (from his orders, or from a ladder rung).
    if (this.plan.length) {
      const next = this.plan.shift();
      const orderAtStart = this.order; // so a new order mid-action is detectable
      const result = await this.executor.run(next);

      /**
       * Orders must not fail silently.
       *
       * Reported live: "go chop woods, come back to me, protect me — nothing worked".
       * The actions were failing and she said nothing, so from his side she looked
       * like she was ignoring him. Now a failed order gets one retry, and if it still
       * fails she says out loud what went wrong.
       */
      /**
       * A cancelled action must never be retried.
       *
       * Live failure: he said "trisha come", then "trisha get foods". The new order
       * cancelled the running `come`, which surfaced as a normal failure ("the goal was
       * changed") rather than an abort — so the retry pushed `come` back on top of the
       * food order and buried it. From his side she ignored him and wandered off.
       *
       * So: only retry if this order is still the current one, and never retry a step
       * that failed because something interrupted it.
       */
      const interrupted =
        result.aborted ||
        /goal was changed|interrupted|cancelled|aborted|superseded/i.test(result.reason || '');
      const orderStillCurrent = this.order && this.order === orderAtStart;

      if (!result.ok && !result.aborted) {
        const isOrder = !!this.order;
        const retried = this._retried === next.name;
        if (isOrder && !retried && !interrupted && orderStillCurrent) {
          this._retried = next.name;
          log.brain(`order step ${next.name} failed (${result.reason}) — retrying once`);
          this.plan.unshift(next);
          return;
        }
        if (interrupted) {
          log.debug(`${next.name} was interrupted — not retrying`);
          this._retried = null;
          return;
        }

        /**
         * Repair the cause, then come back to this step. Capped per step so a genuinely
         * impossible objective cannot become an infinite shopping trip.
         */
        this._repairs = this._repairs || new Map();
        const repairKey = `${next.name}:${result.reason || ''}`.slice(0, 80);
        const attempts = this._repairs.get(repairKey) || 0;
        if (attempts < 2) {
          const repair = this.repairFor(next, result);
          if (repair?.length) {
            this._repairs.set(repairKey, attempts + 1);
            log.brain(`${next.name} blocked (${result.reason}) — fixing that first: ${repair.map((r) => r.name).join(' -> ')}`);
            this.plan.unshift(...repair.map((r) => ({ name: r.name, args: r.args })), next);
            this.commit(45000);
            return;
          }
        }
        this._retried = null;
        if (isOrder) {
          this.say(this.shortExcuse(result.reason));
          log.warn(`order failed: ${next.name} — ${result.reason}`);
        }
        await this.handleFailure(next, result);
      } else {
        this._retried = null;
      }

      if (!this.plan.length && this.order) {
        const done = this.order;
        this.order = null;
        this.reportDone(done, result);
      }
      return;
    }

    // 3. Housekeeping that matters but can wait for his orders to finish.
    //    Gated by the same anti-thrash rule as criticals: a soft emergency that
    //    keeps failing must not be allowed to crowd out the ladder.
    const soft = this.softEmergency();
    if (soft && this.allowCritical(soft)) {
      log.brain(`housekeeping: ${soft.name}`);
      await this.executor.run(soft);
      return;
    }

    /**
     * 3b. THE SURVEYED PLAN.
     *
     * Before any self-directed work, she scouts the area and has the strong model
     * build a plan against what is actually there. This replaces the old behaviour of
     * re-deciding every six seconds with no knowledge of her surroundings, which is
     * what made her walk into the ocean looking for trees that were not there.
     */
    if (config.brain.autonomy && !this.plan.length && !this.sessionPlan?.length) {
      // 25s, not 90s. A 22 minute run logged 'idle with an empty queue' eleven times:
      // she finished a plan and then stood around waiting for permission to make a new
      // one. An idle bot with no plan should be planning.
      if (!this._planning && Date.now() - (this._lastPlanAt || 0) > 25000) {
        this._planning = true;
        this._lastPlanAt = Date.now();
        try {
          const { inventorySummary } = await import('../world/state.js');
          const result = await makePlan(bot, {
            reason: this._planReason || 'starting out',
            inventorySummary: inventorySummary(bot).join(', '),
          });
          this.lastSurvey = result.survey;
          this._planReason = null;
          const steps = result.steps || fallbackPlan(bot, result.survey);
          if (result.say) this.say(result.say);
          if (steps?.length) {
            this.sessionPlan = steps;
            log.brain(`working a ${steps.length}-step plan`);
          }
        } catch (err) {
          log.warn(`planning failed: ${err.message}`);
        } finally {
          this._planning = false;
        }
        return;
      }
    }

    // Work the surveyed plan, one objective at a time.
    if (this.sessionPlan?.length) {
      const step = this.sessionPlan.shift();
      log.brain(`plan step: ${step.name}${step.why ? ` — ${step.why}` : ''}`);
      this._currentStep = step;
      this.plan.push({ name: step.name, args: step.args });
      this.commit(45000);
      return;
    }

    // 4. The ladder — deterministic, free. Skipped entirely in stability mode, where
    //    she waits for orders instead of running her own agenda.
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
        // Give the rung a fair run before her own wandering thoughts can replace it.
        this.commit(45000);
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
    // Do not second-guess a task she only just committed to.
    if (this.committed()) return;
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

    /**
     * Hurt and out of combat. The answer depends on whether healing is even possible:
     * regeneration needs a nearly full food bar, so with an empty pack "heal" fails
     * instantly and re-fires forever. A 420-second soak run logged 547 failed heals
     * before this distinction existed. If she cannot heal, the correct move is to go
     * and get food, which fixes both problems at once.
     */
    if (hp < 12 && !hostiles) {
      const canHeal =
        !!this.reflex.bestFood(true) ||
        bot.inventory.items().some((i) => /golden_apple|^potion$/.test(i.name));
      if (canHeal) return { name: 'heal', args: {} };
      if (bot.food < 18) return { name: 'getFood', args: { urgent: true, count: 6 } };
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

    // Night handling. If she owns a bed, the correct move is to use it — sleeping
    // skips the mob hours entirely and sets her respawn point. She was standing
    // outside all night instead, which is how most of her deaths happened.
    const t = bot.time?.timeOfDay ?? 0;
    const isNight = t > 13000 && t < 23000;
    if (isNight) {
      const hasBed = bot.inventory.items().some((i) => /_bed$/.test(i.name)) || !!mem.all.bed;
      if (hasBed && !this._sleepTried) {
        this._sleepTried = true;
        setTimeout(() => {
          this._sleepTried = false;
        }, 60000);
        return { name: 'sleep', args: {} };
      }
      if (!mem.all.bed && !mem.all.shelterBuilt && this.targeting.pick({ maxDistance: 16 })) {
        return { name: 'shelter', args: {} };
      }
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

    const candidates = nearbyEntities(bot, 12).filter((e) => {
      /**
       * PLAYERS. This filter used to require isHostile, which is false for every
       * player — so the self-defence watcher was structurally incapable of reacting
       * to a human. Live consequence: a player called Rupam beat her to death while
       * she carried on mining, no engage and no retreat, from 15 HP to dead in 17
       * seconds.
       *
       * The targeting layer already encodes the policy properly (provoked, attacking
       * the owner, or free-for-all mode), so defer to its score rather than guessing
       * here. Self-defence still means self-defence: an unprovoked player scores
       * negative and is left alone.
       */
      if (e.isPlayer) return this.targeting.score(e) > 0 && e.distance < 12;

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

  /**
   * DEPENDENCY REPAIR — fix the cause instead of announcing the symptom.
   *
   * "it just says on it then says that didnt work." Exactly right, and the log showed
   * why: a plan step failed for a missing prerequisite and she simply moved to the next
   * step. `mine stone` failed for want of a pickaxe at 08:08:53 and the very next step
   * began at 08:08:54, so the whole plan drained in seconds having achieved nothing.
   *
   * A failure that names what is missing is not a dead end, it is the next task. This
   * turns "I need a stone pickaxe" into "make a stone pickaxe, then carry on".
   */
  repairFor(step, result) {
    if (!step) return null;
    const reason = String(result?.reason || '');

    /**
     * The skill told us exactly which tool is missing.
     *
     * Two at a time for pickaxes: wooden ones last 59 blocks and she was losing whole
     * objectives to a snapped tool, then crafting a single replacement that also broke.
     * A spare costs three cobblestone and saves a wasted trip.
     */
    if (result?.needsTool && typeof result.needsTool === 'string') {
      const tool = result.needsTool;
      const count = /_pickaxe$/.test(tool) ? 2 : 1;
      const steps = [{ name: 'craft', args: { item: tool, count }, why: `need it for ${step.name}` }];
      // Upgrading to stone is nearly free once she is already mining stone.
      if (tool.startsWith('stone_')) {
        steps.unshift({ name: 'mine', args: { block: 'stone', count: 12 }, why: 'cobble for the better tool' });
      }
      return steps;
    }

    // "need 3x cobblestone for stone_pickaxe" — go and get the 3 cobblestone.
    const m = /need (\d+)x ([a-z_]+)/.exec(reason);
    if (m) {
      const count = Math.min(64, Number(m[1]) + 4);
      const item = m[2];
      // Raw materials get mined or chopped; everything else gets crafted.
      if (/^(cobblestone|stone|cobbled_deepslate|deepslate|andesite|diorite|granite)$/.test(item)) {
        return [{ name: 'mine', args: { block: 'stone', count }, why: `${step.name} needs ${item}` }];
      }
      if (/_log$|^log$/.test(item)) {
        return [{ name: 'chopWood', args: { count }, why: `${step.name} needs logs` }];
      }
      if (/_planks$/.test(item)) {
        return [{ name: 'chopWood', args: { count: 8 }, why: `${step.name} needs planks, so logs first` }];
      }
      if (/_ore$|^raw_/.test(item)) {
        return [{ name: 'mine', args: { block: item.replace(/^raw_/, '') + (item.startsWith('raw_') ? '_ore' : ''), count } }];
      }
      return [{ name: 'craft', args: { item, count }, why: `${step.name} needs ${item}` }];
    }

    // No crafting table in reach: make one.
    if (/needs a crafting table/.test(reason)) {
      return [{ name: 'craft', args: { item: 'crafting_table', count: 1 }, why: 'need a bench' }];
    }

    /**
     * "missing ingredient" — mineflayer's generic craft rejection, with no clue about
     * what was missing. It had NO repair mapping, so it was a hard dead end: she looped
     * mine-stone -> pickaxe-broke -> craft-pickaxe -> missing ingredient -> forever, and
     * never once reached stone tier in a 22 minute run. Infer the material from what she
     * was trying to make.
     */
    if (/missing ingredient|no usable recipe/.test(reason)) {
      const item = String(step.args?.item || '');
      if (/^wooden_|^crafting_table$|_planks$|^stick$|^bowl$|^chest$/.test(item)) {
        return [{ name: 'chopWood', args: { count: 10 }, why: `no wood for ${item || step.name}` }];
      }
      if (/^stone_|^furnace$/.test(item)) {
        return [{ name: 'mine', args: { block: 'stone', count: 16 }, why: `no cobble for ${item}` }];
      }
      if (/^iron_/.test(item)) {
        return [
          { name: 'mine', args: { block: 'iron_ore', count: 6, optional: true }, why: 'raw iron' },
          { name: 'smelt', args: { item: 'iron_ingot', count: 6 }, why: 'smelt it' },
        ];
      }
      if (/^torch$/.test(item)) {
        return [{ name: 'mine', args: { block: 'coal_ore', count: 6, optional: true }, why: 'coal for torches' }];
      }
      // Unknown recipe: wood is the cheapest thing that unblocks most of them.
      return [{ name: 'chopWood', args: { count: 8 }, why: 'restock basics' }];
    }

    // Not enough building material.
    if (/not enough building blocks/.test(reason)) {
      return [{ name: 'mine', args: { block: 'stone', count: 32 }, why: 'stone for the build' }];
    }

    // No torches: coal, then torches.
    if (/no torches/.test(reason)) {
      return [
        { name: 'mine', args: { block: 'coal_ore', count: 6, optional: true }, why: 'coal for torches' },
        { name: 'craft', args: { item: 'torch', count: 8, optional: true }, why: 'light' },
      ];
    }
    return null;
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
    // A death invalidates the plan: she is somewhere else now, with nothing on her.
    this.sessionPlan = null;
    this._lastPlanAt = 0;
    this._planReason = `you just died to ${this.guessDeathCause()} — plan more carefully this time`;
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
