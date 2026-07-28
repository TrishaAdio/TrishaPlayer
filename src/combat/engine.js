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
import { equipWeapon, bestWeapon } from '../reflex/gear.js';
import { mem } from '../world/memory.js';
import { params, paramSource, sanitise } from './params.js';

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

    await equipWeapon(bot).catch(() => {});
    log.act(`engaging ${target.username || target.name}${isPlayer ? ' (PLAYER)' : ''}`);

    try {
      while (!this.abort) {
        const live = bot.entities[target.id];
        if (!live || live.isValid === false) {
          this.kills++;
          mem.bump(isPlayer ? 'playerKills' : 'kills');
          if (profile) profile.wins = (profile.wins || 0) + 1;
          log.act(`${target.username || target.name} down`);
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
        if (dist > (pursue ? this.p.pursueRange : 6)) return { ok: false, reason: 'target escaped' };

        await this.combatStep(live, dist, isPlayer);
        await wait(50);
      }
      return { ok: false, reason: 'aborted' };
    } finally {
      this.clearControls();
      this.active = false;
      this.target = null;
      this.reflex.dropShield();
    }
  }

  /** One tick of fighting. */
  async combatStep(target, dist, isPlayer) {
    const bot = this.bot;

    // Always face the hitbox centre-mass.
    const aim = target.position.offset(0, target.height ? target.height * 0.85 : 1.4, 0);
    await bot.lookAt(aim, true).catch(() => {});

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
    const crit = this.canCrit();
    try {
      bot.attack(target);
      this.lastSwing = Date.now();
      this.swings++;
      if (isPlayer) this.noteOpponent(target, 'myHits');
      log.debug(`swing${crit ? ' (CRIT)' : ''} ${this.bot.heldItem?.name || 'fist'}`);
    } catch {}

    // SPRINT RESET: re-engage sprint right after the hit for knockback on the next one.
    bot.setControlState('sprint', false);
    await wait(this.p.sprintResetMs);
    bot.setControlState('sprint', true);
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
    for (let i = 0; i < shots && !this.abort; i++) {
      const live = bot.entities[target.id];
      if (!live || live.isValid === false) return { ok: true, killed: true };

      const dist = bot.entity.position.distanceTo(live.position);
      const flightTime = dist / 40; // arrow ~40 blocks/s at full draw
      const lead = live.velocity ? live.velocity.scaled(flightTime * 20 * this.p.bowLeadFactor) : new Vec3(0, 0, 0);
      const drop = Math.min(2.2, dist * this.p.bowDropFactor); // gravity compensation
      const aim = live.position.offset(0, (live.height || 1.8) * 0.6 + drop, 0).plus(lead);

      await bot.lookAt(aim, true).catch(() => {});
      bot.activateItem();
      await wait(this.p.bowDrawMs); // full draw
      bot.deactivateItem();
      await wait(350);
    }
    await equipWeapon(bot).catch(() => {});
    return { ok: true };
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
