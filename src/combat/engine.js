/**
 * COMBAT ENGINE
 *
 * Where "pro" actually lives. None of this is prompted — it is mechanical
 * execution of 1.9+ combat at a precision no human hits consistently.
 *
 * The techniques, and why each one matters:
 *
 *  - COOLDOWN DISCIPLINE. Swinging before the attack cooldown refills deals a
 *    fraction of full damage. Spam-clicking is the #1 tell of a bad player (and of
 *    every naive bot). She swings only on a full meter, every time.
 *
 *  - JUMP CRITS. A critical hit is +50% damage and requires falling, airborne, not
 *    in water — and crucially NOT SPRINTING. Sprinting cancels crits, which is why
 *    naive "sprint at them and click" bots do reduced damage forever.
 *
 *  - SPRINT-RESET / W-TAP. Landing a hit while sprinting adds knockback. Releasing
 *    and re-pressing sprint between hits resets the sprint-knockback, keeping the
 *    opponent pushed away and their combo broken.
 *
 *  - STRAFE CIRCLING. Orbiting the target at reach edge makes her a moving target,
 *    ruins their aim, and keeps her behind their swing arc.
 *
 *  - REACH DISCIPLINE. Hits only inside 3.0 blocks — vanilla legal. She wins by
 *    timing, not by looking like a cheat client to anti-cheat.
 *
 *  - SHIELD CYCLING. Shield raised during cooldown, dropped to swing.
 *
 *  - OPPONENT MODELLING. Per-player habits recorded and reused (see profiles).
 */
import { Vec3 } from 'vec3';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { equipWeapon, bestWeapon, bestAxeWeapon, bestSword, equipNamed } from '../reflex/gear.js';
import { mem } from '../world/memory.js';
import { params, paramSource, sanitise } from './params.js';
import { aimSolution, hasClearShot, ARROW_SPEED } from './ranged.js';
import { FLYING } from '../world/scan.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Attack-speed cooldowns in ms (vanilla 1.9+). */
const COOLDOWN = {
  netherite_sword: 625, diamond_sword: 625, iron_sword: 625, stone_sword: 625, golden_sword: 625, wooden_sword: 625,
  netherite_axe: 1000, diamond_axe: 1000, iron_axe: 1112, stone_axe: 1250, golden_axe: 1000, wooden_axe: 1250,
  trident: 833, netherite_pickaxe: 500, diamond_pickaxe: 500, iron_pickaxe: 500,
  default: 500,
};

/**
 * Spacing and timing live in combat/params.js so `scripts/tune.js` can sweep them
 * with real duels. REACH stays a hard constant: it is a vanilla rule, not a
 * preference, and letting a tuner raise it would just make her look like a cheat.
 */
const REACH = 3.0; // vanilla entity reach — never tunable

export class CombatEngine {
  /**
   * @param paramOverride optional per-instance parameter patch. Exists so the
   * sparring harness can run two fighters with different profiles inside one
   * process and duel them against each other.
   */
  constructor(bot, reflex, targeting, paramOverride = null) {
    this.bot = bot;
    this.paramOverride = paramOverride;
    this.reflex = reflex;
    this.targeting = targeting;
    this.active = false;
    this.target = null;
    this.lastSwing = 0;
    this.strafeDir = 1;
    this.lastStrafeFlip = 0;
    this.jumping = false;
    this.abort = false;
    this.profiles = mem.all.opponents || (mem.all.opponents = {});
    this.kills = 0;
    this.p = paramOverride ? { ...params(), ...sanitise(paramOverride) } : params();
    this.swings = 0;
    // Shield-break bookkeeping.
    this.swingsSinceLand = 0;
    this.usingAxe = false;
    this.shieldBrokenUntil = 0;
    this.arrowsFired = 0;
    log.debug(`combat engine using ${paramOverride ? 'per-instance override' : paramSource()}`);
  }

  cooldownMs() {
    const held = this.bot.heldItem?.name;
    return (COOLDOWN[held] ?? COOLDOWN.default) + (this.p.cooldownSlackMs || 0);
  }

  cooldownReady() {
    return Date.now() - this.lastSwing >= this.cooldownMs();
  }

  /** Crit conditions: airborne, descending, not sprinting, not in water. */
  canCrit() {
    const e = this.bot.entity;
    return !e.onGround && e.velocity.y < this.p.critWindowVy && !e.isInWater;
  }

  clearControls() {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      this.bot.setControlState(c, false);
    }
  }

  /**
   * AXE DOCTRINE — the answer to anyone who hides behind a shield.
   *
   * A shield negates a sword hit entirely, so against a blocker a sword duel is
   * unwinnable no matter how good the timing is. An axe hit disables the shield for
   * five seconds. So: open with the axe to break the block, then switch back to the
   * sword, which out-damages the axe over time thanks to its faster cooldown.
   *
   * Detection is behavioural rather than metadata-based, because the "hand active"
   * bit moves between protocol versions but "my hits are landing on nothing" is
   * true in every version. Two swings with no damage registered on a target that is
   * holding a shield means the shield is up.
   */
  targetHasShield(target) {
    try {
      return target?.equipment?.some((e) => e?.name === 'shield') || false;
    } catch {
      return false;
    }
  }

  targetIsBlocking(target) {
    if (!this.targetHasShield(target)) return false;
    if (Date.now() < this.shieldBrokenUntil) return false; // already broken
    return this.swingsSinceLand >= 2;
  }

  shouldUseAxe(target, isPlayer) {
    if (!isPlayer) return false;
    const axe = bestAxeWeapon(this.bot);
    if (!axe) return false;
    if (Date.now() < this.shieldBrokenUntil) return false; // window is open, use the sword

    if (this.targetIsBlocking(target)) return true;

    // Someone who blocked in past fights gets the axe from the first swing.
    const profile = this.profileFor(target);
    if (profile && (profile.theyBlock || 0) >= 2 && this.swings < 2) return true;
    return false;
  }

  async armFor(target, isPlayer) {
    const wantAxe = this.shouldUseAxe(target, isPlayer);
    if (!this.p.useAxe) return; // sparring archetypes that do not know the trick
    if (wantAxe && !this.usingAxe) {
      const axe = bestAxeWeapon(this.bot);
      if (await equipNamed(this.bot, axe)) {
        this.usingAxe = true;
        this.noteOpponent(target, 'theyBlock');
        log.act(`shield up — switching to ${axe.name} to break it`);
      }
    } else if (!wantAxe && this.usingAxe) {
      const sword = bestSword(this.bot);
      if (sword && (await equipNamed(this.bot, sword))) {
        this.usingAxe = false;
        log.debug('shield broken, back to the sword');
      }
    }
  }

  /** Opponent habits, per username, remembered across sessions. */
  profileFor(entity) {
    if (!entity?.username) return null;
    const p = (this.profiles[entity.username] = this.profiles[entity.username] || {
      fights: 0, theirHits: 0, myHits: 0, theyJump: 0, theyBlock: 0, theyRetreat: 0, wins: 0, losses: 0,
    });
    return p;
  }

  noteOpponent(entity, key, by = 1) {
    const p = this.profileFor(entity);
    if (p) {
      p[key] = (p[key] || 0) + by;
      mem.set('opponents', this.profiles);
    }
  }

  /**
   * OPPONENT MODELLING — profiles that change behaviour, not just statistics.
   *
   * Recording that someone blocks a lot is worthless on its own. This turns the
   * record into a per-fight parameter patch and an opening plan, so the second time
   * she meets a player she already fights them differently.
   *
   * A human needs twenty fights to read a pattern. She needs two, and never forgets.
   */
  strategyFor(target) {
    const profile = this.profileFor(target);
    if (!profile || (profile.fights || 0) < 1) return { patch: {}, notes: [] };

    const patch = {};
    const notes = [];
    const fights = Math.max(1, profile.fights);
    const lost = profile.losses || 0;

    // Blocks constantly -> the axe opener is already handled in shouldUseAxe.
    if ((profile.theyBlock || 0) >= 2) notes.push('shield camper: axe opener');

    // Runs away -> chase harder and further, and stop giving them space.
    if ((profile.theyRetreat || 0) / fights > 0.5) {
      patch.pursueRange = 32;
      patch.engageRange = Math.max(2.9, (this.p.engageRange || 3.1) - 0.2);
      patch.jumpApproachChance = 0.6;
      notes.push('runner: tighter pursuit');
    }

    // Jumps a lot -> they are chasing crits. Sit slightly wider so their jump
    // arc lands short, and punish the recovery frames.
    if ((profile.theyJump || 0) / fights > 3) {
      patch.engageRange = (this.p.engageRange || 3.1) + 0.25;
      patch.strafeMinMs = 500;
      notes.push('jumper: wider spacing');
    }

    // She has been losing to this one -> stop trading, kite and reset instead.
    if (lost >= 2 && lost > (profile.wins || 0)) {
      patch.breakOffHp = Math.max(8, (this.p.breakOffHp || 6) + 3);
      patch.tooClose = (this.p.tooClose || 1.8) + 0.4;
      notes.push('beat her before: more caution, earlier resets');
    }

    return { patch, notes };
  }

  /**
   * LATENCY COMPENSATION.
   *
   * Her parameters were tuned in a sandbox at ~1ms ping. A real server is not that:
   * RAREAURA's is ~250ms round trip, and at that distance two things break.
   *
   * First, the server sees her swing a quarter of a second after she decides to make
   * it, so a swing fired the instant her local cooldown expires can arrive before the
   * server's cooldown has refilled — and a too-early swing deals a fraction of full
   * damage. Adding part of the latency as slack keeps every hit at full strength.
   *
   * Second, entity positions she receives are already stale by one round trip, so an
   * opponent at a locally-measured 3.0 blocks may really be further away. Sitting
   * slightly tighter keeps her inside genuine reach.
   *
   * Measured live: 15 swings for 5 kills at 246ms, which is a lot of wasted swings.
   */
  applyLatencyCompensation() {
    const bot = this.bot;
    const ping = bot.players?.[bot.username]?.ping ?? bot._client?.latency ?? 0;
    this.lastPing = ping;
    if (!ping || ping < 60) return; // local or near-local: leave the tuned profile alone

    const slack = Math.min(140, Math.round(ping * 0.3));
    const tighten = Math.min(0.35, ping / 900);

    this._latencyPatch = this.p;
    this.p = {
      ...this.p,
      cooldownSlackMs: Math.max(this.p.cooldownSlackMs || 0, slack),
      engageRange: Math.max(2.7, (this.p.engageRange || 3.1) - tighten),
      tooClose: Math.max(1.4, (this.p.tooClose || 1.8) - 0.15),
    };
    log.act(`ping ${ping}ms — compensating (+${slack}ms swing slack, engage ${this.p.engageRange.toFixed(2)})`);
  }

  /** Apply an opponent-specific patch for the duration of one fight. */
  applyStrategy(target) {
    const { patch, notes } = this.strategyFor(target);
    this._basePatch = null;
    if (!Object.keys(patch).length) return;
    this._basePatch = this.p;
    this.p = { ...this.p, ...sanitise(patch) };
    log.act(`read on ${target.username}: ${notes.join(', ')}`);
  }

  restoreStrategy() {
    if (this._basePatch) {
      this.p = this._basePatch;
      this._basePatch = null;
    }
    if (this._latencyPatch) {
      this.p = this._latencyPatch;
      this._latencyPatch = null;
    }
  }

  /**
   * Main fight loop. Runs until the target dies, flees, or she's told to stop.
   */
  /**
   * CREEPER DOCTRINE — the one mob you never brawl.
   *
   * Standing at melee reach trading hits with a creeper is how bots die, because
   * the fuse starts the moment you are inside 3 blocks and finishes before the
   * attack cooldown refills. So:
   *   - bow in the pack? kill it from 10 blocks and never let it close.
   *   - melee only? strict hit-and-run: one swing, immediate sprint back out of
   *     blast radius, wait out the fuse, repeat.
   *   - hurt? walk away entirely. A creeper is never worth dying for.
   */
  async fightCreeper(creeper) {
    const bot = this.bot;
    const hasBow = bot.inventory.items().some((i) => i.name === 'bow' || i.name === 'crossbow');
    const hasArrows = bot.inventory.items().some((i) => /arrow/.test(i.name));

    if (hasBow && hasArrows) {
      log.act('creeper — shooting it from range');
      // Back off first so the shots happen outside blast radius.
      const away = bot.entity.position.minus(creeper.position).normalize().scaled(this.p.creeperShootRange);
      await bot.lookAt(bot.entity.position.plus(away), true).catch(() => {});
      bot.setControlState('sprint', true);
      bot.setControlState('forward', true);
      await wait(900);
      this.clearControls();
      const res = await this.shoot(creeper, { shots: 5 });
      if (!bot.entities[creeper.id]) {
        this.kills++;
        mem.bump('kills');
        return { ok: true, killed: true };
      }
      return res;
    }

    if (bot.health < this.p.creeperMinHp) {
      log.act('creeper — not worth it, backing off');
      await this.disengage(creeper);
      return { ok: false, reason: 'avoided creeper' };
    }

    log.act('creeper — hit and run');
    await equipWeapon(bot).catch(() => {});
    for (let round = 0; round < 6 && !this.abort; round++) {
      const live = bot.entities[creeper.id];
      if (!live) {
        this.kills++;
        mem.bump('kills');
        log.act('creeper down');
        return { ok: true, killed: true };
      }
      if (bot.health < 12) {
        await this.disengage(live);
        return { ok: false, reason: 'broke off from creeper' };
      }

      // Close in just far enough to reach.
      let guard = 0;
      while (bot.entity.position.distanceTo(live.position) > REACH && guard++ < 30 && !this.abort) {
        await bot.lookAt(live.position.offset(0, 1, 0), true).catch(() => {});
        bot.setControlState('sprint', true);
        bot.setControlState('forward', true);
        await wait(80);
      }
      this.clearControls();

      // One hit, with knockback from the sprint.
      if (bot.entity.position.distanceTo(live.position) <= REACH + 0.4) {
        try {
          bot.attack(live);
          this.lastSwing = Date.now();
        } catch {}
      }

      // Immediately out of the blast radius — this is the whole trick.
      const away = bot.entity.position.minus(live.position).normalize().scaled(7);
      await bot.lookAt(bot.entity.position.plus(away), true).catch(() => {});
      bot.setControlState('sprint', true);
      bot.setControlState('forward', true);
      await wait(this.p.creeperHitRunBackoffMs);
      this.clearControls();
      // Let the fuse reset before going again.
      await wait(this.cooldownMs());
    }
    return { ok: false, reason: 'creeper survived the hit and run' };
  }

  async fight(target, { timeoutMs = 90000, pursue = true } = {}) {
    if (!target) return { ok: false, reason: 'no target' };
    const bot = this.bot;

    /**
     * Refuse an unwinnable chase up front rather than discovering it 26 seconds later.
     * A flying mob with no bow in her pack is not a fight she can have.
     */
    if (FLYING.has(target.name)) {
      const hasArrows =
        bot.inventory.items().some((i) => i.name === 'bow' || i.name === 'crossbow') &&
        bot.inventory.items().some((i) => /arrow/.test(i.name));
      if (!hasArrows) {
        return { ok: false, reason: `${target.name} flies and she has no bow — not chasing it` };
      }
      return this.shoot(target, { shots: 4 });
    }

    if (target.name === 'creeper') {
      this.active = true;
      this.abort = false;
      this.target = target;
      try {
        return await this.fightCreeper(target);
      } finally {
        this.clearControls();
        this.active = false;
        this.target = null;
      }
    }
    this.active = true;
    this.abort = false;
    this.target = target;
    const started = Date.now();
    const isPlayer = target.type === 'player';
    const profile = this.profileFor(target);
    if (profile) profile.fights++;
    // Compensate for network latency before anything else — on a remote server this
    // matters more than any tuning parameter.
    this.applyLatencyCompensation();
    // Fight this specific person the way they have shown they play.
    if (isPlayer) this.applyStrategy(target);
    let theirJumps = 0;
    let theirRetreatTicks = 0;

    await equipWeapon(bot).catch(() => {});
    log.act(`engaging ${target.username || target.name}${isPlayer ? ' (PLAYER)' : ''}`);

    /**
     * Damage feedback. Without this she cannot tell a blocked hit from a landed one,
     * and the whole shield-break decision has nothing to run on.
     */
    this.swingsSinceLand = 0;
    this.usingAxe = false;
    this.shieldBrokenUntil = 0;
    const onHurt = (entity) => {
      if (entity?.id !== target.id) return;
      this.swingsSinceLand = 0;
      if (this.usingAxe) {
        // An axe hit that lands disables their shield for five seconds.
        this.shieldBrokenUntil = Date.now() + 5000;
        log.debug('axe landed — shield disabled for 5s');
      }
    };
    bot.on('entityHurt', onHurt);

    try {
      while (!this.abort) {
        const live = bot.entities[target.id];
        if (!live || live.isValid === false) {
          this.kills++;
          mem.bump(isPlayer ? 'playerKills' : 'kills');
          if (profile) profile.wins = (profile.wins || 0) + 1;
          log.act(`${target.username || target.name} down`);
          // Pick up what it dropped. Observed live: she was killing mobs and walking
          // away from the meat, then going hungry later with food on the ground behind
          // her. A kill is not finished until the drops are collected.
          await this.lootKill(target).catch(() => {});
          return { ok: true, killed: true };
        }
        if (Date.now() - started > timeoutMs) return { ok: false, reason: 'fight timed out' };

        // Reflex owns survival: if she is in panic, break off and let it work.
        if (this.reflex.panic && bot.health <= this.p.breakOffHp) {
          log.act('breaking off, too low');
          await this.disengage(live);
          return { ok: false, reason: 'retreated at low hp' };
        }

        const dist = bot.entity.position.distanceTo(live.position);
        if (dist > (pursue ? this.p.pursueRange : 6)) {
          if (isPlayer) this.noteOpponent(target, 'theyRetreat');
          return { ok: false, reason: 'target escaped' };
        }

        // Observe them while fighting: this is what feeds the next fight.
        if (isPlayer) {
          if (!live.onGround && (live.velocity?.y ?? 0) > 0.1) theirJumps++;
          const openingUp = bot.entity.position.distanceTo(live.position) > dist;
          if (openingUp) theirRetreatTicks++;
        }

        await this.combatStep(live, dist, isPlayer);
        await wait(50);
      }
      return { ok: false, reason: 'aborted' };
    } finally {
      // Bank what she learned about them, then drop the per-fight tuning.
      if (isPlayer && profile) {
        if (theirJumps > 0) this.noteOpponent(target, 'theyJump', Math.min(20, Math.round(theirJumps / 10)));
        if (theirRetreatTicks > 40) this.noteOpponent(target, 'theyRetreat');
        if (bot.health <= 0) profile.losses = (profile.losses || 0) + 1;
      }
      this.restoreStrategy();
      bot.removeListener('entityHurt', onHurt);
      this.clearControls();
      this.active = false;
      this.target = null;
      this.reflex.dropShield();
    }
  }

  /** One tick of fighting. */
  async combatStep(target, dist, isPlayer) {
    const bot = this.bot;

    // Handicaps exist so a sparring partner can be made human-like. Both are zero
    // for Trisha herself, so this costs her nothing.
    if (this.p.reactionDelayMs > 0) await wait(this.p.reactionDelayMs);

    // Always face the hitbox centre-mass.
    const aim = target.position.offset(0, target.height ? target.height * 0.85 : 1.4, 0);
    if (this.p.aimErrorDeg > 0) {
      const err = (this.p.aimErrorDeg * Math.PI) / 180;
      const jx = (Math.random() - 0.5) * 2 * err * dist;
      const jz = (Math.random() - 0.5) * 2 * err * dist;
      await bot.lookAt(aim.offset(jx, 0, jz), true).catch(() => {});
    } else {
      await bot.lookAt(aim, true).catch(() => {});
    }

    const p = this.p;

    // Ranged mobs: close the gap fast rather than trade arrows.
    if (dist > p.engageRange) {
      bot.setControlState('sprint', true);
      bot.setControlState('forward', true);
      bot.setControlState('left', false);
      bot.setControlState('right', false);
      // Sprint-jump to cover ground.
      if (dist > p.sprintApproachFrom && bot.entity.onGround && Math.random() < p.jumpApproachChance) {
        bot.setControlState('jump', true);
        setTimeout(() => bot.setControlState('jump', false), 80);
      }
      return;
    }

    bot.setControlState('forward', false);

    // Strafe-circle at reach edge, flipping direction unpredictably.
    const flipAfter = p.strafeMinMs + Math.random() * (p.strafeMaxMs - p.strafeMinMs);
    if (Date.now() - this.lastStrafeFlip > flipAfter) {
      this.strafeDir *= -1;
      this.lastStrafeFlip = Date.now();
    }
    bot.setControlState('left', this.strafeDir < 0);
    bot.setControlState('right', this.strafeDir > 0);

    // Too close: back off a touch so she keeps her reach advantage.
    if (dist < p.tooClose) {
      bot.setControlState('back', true);
      setTimeout(() => bot.setControlState('back', false), 120);
    }

    const ready = this.cooldownReady();

    // Shield up while the cooldown refills, down to swing.
    if (p.shieldDuringCooldown && !ready && bot.inventory.slots[45]?.name === 'shield' && dist < p.shieldRange) {
      if (!this.reflex.blocking) {
        this.reflex.blocking = true;
        bot.activateItem(true);
      }
    } else if (this.reflex.blocking) {
      this.reflex.blocking = false;
      bot.deactivateItem();
    }

    // Pick the right weapon for what they are doing right now.
    if (isPlayer && ready) await this.armFor(target, isPlayer);

    if (!ready || dist > REACH) return;

    // CRIT SETUP: drop sprint (sprinting cancels crits), hop, hit on the way down.
    if (p.requireCrit && bot.entity.onGround && !this.jumping) {
      bot.setControlState('sprint', false);
      bot.setControlState('jump', true);
      this.jumping = true;
      setTimeout(() => {
        bot.setControlState('jump', false);
        this.jumping = false;
      }, p.critJumpHoldMs);
      return; // swing next tick, mid-descent
    }

    if (this.canCrit() || dist <= REACH) {
      await this.swing(target, isPlayer);
    }
  }

  async swing(target, isPlayer) {
    const bot = this.bot;
    if (this.reflex.blocking) {
      this.reflex.blocking = false;
      bot.deactivateItem();
      await wait(30);
    }
    // Fumbled clicks, for human-like sparring partners only.
    if (this.p.missChance > 0 && Math.random() < this.p.missChance) {
      this.lastSwing = Date.now();
      this.swingsSinceLand++;
      return;
    }

    const crit = this.canCrit();
    try {
      bot.attack(target);
      this.lastSwing = Date.now();
      this.swings++;
      this.swingsSinceLand++;
      if (isPlayer) this.noteOpponent(target, 'myHits');
      log.debug(`swing${crit ? ' (CRIT)' : ''} ${this.bot.heldItem?.name || 'fist'}`);
    } catch {}

    // SPRINT RESET: re-engage sprint right after the hit for knockback on the next one.
    bot.setControlState('sprint', false);
    await wait(this.p.sprintResetMs);
    bot.setControlState('sprint', true);
  }

  /**
   * Collect what a kill dropped. Dynamic import keeps combat and gathering from
   * forming a circular dependency at module load.
   */
  async lootKill(target) {
    const bot = this.bot;
    try {
      await wait(700); // let the drops actually spawn
      const { collectDrops } = await import('../skills/gather.js');
      const { Task } = await import('../task.js');
      const res = await collectDrops(bot, new Task('loot'), { radius: 8, quiet: true });
      if (res?.got) log.act(`looted ${res.got} drop(s) from ${target.username || target.name}`);
    } catch {}
  }

  /** Break off cleanly: shield up, walk backwards, then run. */
  async disengage(target) {
    const bot = this.bot;
    this.clearControls();
    if (bot.inventory.slots[45]?.name === 'shield') {
      bot.activateItem(true);
      this.reflex.blocking = true;
    }
    if (target) {
      const away = bot.entity.position.minus(target.position).normalize().scaled(8);
      await bot.lookAt(bot.entity.position.plus(away), true).catch(() => {});
    }
    bot.setControlState('sprint', true);
    bot.setControlState('forward', true);
    await wait(1200);
    this.clearControls();
    this.reflex.dropShield();
  }

  /**
   * Bow work: full charge, then lead the target using its velocity so the arrow
   * arrives where they will be, not where they were.
   */
  async shoot(target, { shots = 3 } = {}) {
    const bot = this.bot;
    const bow = bot.inventory.items().find((i) => i.name === 'bow' || i.name === 'crossbow');
    if (!bow) return { ok: false, reason: 'no bow' };
    const arrows = bot.inventory.items().find((i) => /arrow/.test(i.name));
    if (!arrows) return { ok: false, reason: 'no arrows' };

    await bot.equip(bow, 'hand');
    let fired = 0;
    let blocked = 0;

    for (let i = 0; i < shots && !this.abort; i++) {
      const live = bot.entities[target.id];
      if (!live || live.isValid === false) return { ok: true, killed: true, detail: `${fired} arrows fired` };

      /**
       * Solved trajectory, not an estimate: the pitch comes from simulating the
       * arrow tick-by-tick with drag and gravity, and the lead is iterated against
       * the resulting flight time. Accurate to under a hundredth of a block out to
       * 60 blocks, which is far tighter than a player hitbox.
       */
      const sol = aimSolution(bot, live, {
        speed: ARROW_SPEED,
        leadFactor: this.p.bowLeadFactor,
        passes: 3,
      });
      if (!sol) {
        await wait(200);
        continue;
      }

      // Don't put arrows into terrain.
      if (!hasClearShot(bot, live, sol)) {
        blocked++;
        if (blocked >= 3) {
          await equipWeapon(bot).catch(() => {});
          return { ok: false, reason: 'no clear shot', detail: `${fired} arrows fired` };
        }
        // Sidestep and try to open the lane.
        bot.setControlState(this.strafeDir > 0 ? 'right' : 'left', true);
        await wait(350);
        this.clearControls();
        continue;
      }

      // Draw first, aim at the moment of release: the target keeps moving while
      // the bow charges, so aiming before the draw would be aiming at history.
      bot.activateItem();
      await wait(Math.max(1000, this.p.bowDrawMs)); // full power needs a full second

      const finalTarget = bot.entities[target.id];
      if (finalTarget) {
        const release = aimSolution(bot, finalTarget, {
          speed: ARROW_SPEED,
          leadFactor: this.p.bowLeadFactor,
          passes: 2,
        });
        if (release) await bot.look(release.yaw, release.pitch, true).catch(() => {});
      }
      bot.deactivateItem();
      fired++;
      this.arrowsFired = (this.arrowsFired || 0) + 1;
      log.debug(`arrow ${fired}: ${sol.distance.toFixed(1)}m, pitch ${(sol.pitch * 180 / Math.PI).toFixed(1)}deg, flight ${sol.flightSeconds.toFixed(2)}s`);

      await wait(250);
      if (!bot.inventory.items().some((i) => /arrow/.test(i.name))) break;
    }

    await equipWeapon(bot).catch(() => {});
    return { ok: fired > 0, detail: `${fired} arrows fired` };
  }

  /**
   * BOW KITING. Stay outside their reach, keep arrows going in.
   * Only worth it while she actually has range on them; the moment they close, the
   * sword is the better tool and the melee loop takes over.
   */
  async kite(target, { maxShots = 8, keepDistance = 10 } = {}) {
    const bot = this.bot;
    const hasArrows = bot.inventory.items().some((i) => /arrow/.test(i.name));
    if (!hasArrows) return { ok: false, reason: 'no arrows to kite with' };

    for (let i = 0; i < maxShots && !this.abort; i++) {
      const live = bot.entities[target.id];
      if (!live) return { ok: true, killed: true };

      const dist = bot.entity.position.distanceTo(live.position);
      if (dist < keepDistance * 0.6) {
        // Back off to re-open the gap, facing them the whole time.
        const away = bot.entity.position.minus(live.position).normalize().scaled(6);
        await bot.lookAt(bot.entity.position.plus(away), true).catch(() => {});
        bot.setControlState('sprint', true);
        bot.setControlState('forward', true);
        await wait(600);
        this.clearControls();
        if (bot.entity.position.distanceTo(live.position) < 4) {
          return { ok: false, reason: 'they closed the gap' };
        }
      }
      const res = await this.shoot(live, { shots: 1 });
      if (res.killed) return { ok: true, killed: true };
      if (!res.ok && res.reason === 'no arrows') break;
    }
    return { ok: true, detail: 'kited' };
  }

  /** Player duel: same engine, tighter and more aggressive, uses their profile. */
  async duel(target) {
    const profile = this.profileFor(target);
    if (profile?.fights > 0) {
      log.act(`duelling ${target.username} — ${profile.fights} previous fights on record`);
    }
    return this.fight(target, { timeoutMs: 120000, pursue: true });
  }

  stop() {
    this.abort = true;
    this.clearControls();
  }
}
