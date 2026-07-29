/**
 * The reflex layer. Twenty times a second, zero LLM calls, overrides every order.
 *
 * This is the difference between a bot and a noob. Nothing here waits on a model,
 * because a creeper fuse is 1.5 seconds and a model call is up to five.
 */
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { standingDanger, groundBelow, hostilesNear } from '../world/scan.js';
import { equipShield } from './gear.js';
import { Clutch } from './clutch.js';

const GOOD_FOOD = [
  'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_salmon',
  'cooked_chicken', 'cooked_rabbit', 'bread', 'baked_potato', 'cooked_cod', 'apple',
  'melon_slice', 'carrot', 'sweet_berries', 'beetroot', 'dried_kelp',
];
// Eaten only when genuinely starving.
const DESPERATE_FOOD = ['beef', 'porkchop', 'mutton', 'chicken', 'cod', 'salmon', 'rabbit', 'rotten_flesh', 'spider_eye'];
const NEVER_EAT = ['poisonous_potato', 'pufferfish', 'chorus_fruit', 'golden_apple', 'enchanted_golden_apple', 'suspicious_stew'];

export class Reflex extends EventEmitter {
  constructor(bot) {
    super();
    this.bot = bot;
    this.panic = false;
    this.eating = false;
    this.blocking = false;
    this.escaping = false;
    this.mlgArmed = false;
    this.lastEat = 0;
    this.lastPanic = 0;
    this.suspended = false;
    this.hpFloor = config.ladder.homeHp;
    this._prevHealth = 20;
    this.clutch = new Clutch(bot, this);
    this._creeperCooldown = 0;
  }

  install() {
    const bot = this.bot;
    bot.on('physicsTick', () => this.tick().catch(() => {}));

    bot.on('health', () => {
      const hp = bot.health;
      const dropped = this._prevHealth - hp;
      this._prevHealth = hp;
      if (dropped >= 3) this.emit('bigHit', dropped);
      if (hp <= this.hpFloor && !this.panic) this.enterPanic(`hp ${hp}`);
      if (hp > this.hpFloor + 5 && this.panic) this.exitPanic();
    });

    bot.on('entityHurt', (entity) => {
      if (entity === bot.entity) return;
      const owner = bot.players[config.owner]?.entity;
      if (owner && entity === owner) this.emit('ownerHurt', owner);
    });

    bot.on('death', () => {
      this.panic = false;
      this.escaping = false;
      log.warn('she died');
    });

    log.info('reflex layer armed');
    return this;
  }

  enterPanic(reason) {
    if (this.panic) return;
    this.panic = true;
    this.lastPanic = Date.now();
    // Rate-limit the log: a recurring hazard (swimming in a lake) used to print
    // hundreds of identical lines and bury everything useful.
    if (reason !== this._lastPanicReason || Date.now() - (this._lastPanicLog || 0) > 15000) {
      log.reflex(`PANIC: ${reason}`);
      this._lastPanicLog = Date.now();
      this._lastPanicReason = reason;
    }
    this.emit('panic', reason);
  }

  exitPanic() {
    if (!this.panic) return;
    this.panic = false;
    log.reflex('recovered');
    this.emit('calm');
  }

  /**
   * Off-hand arbitration. Only one thing can live in the off-hand, and the totem
   * outranks the shield when she is inside one-hit range — a shield reduces damage,
   * a totem cancels death. Without this rule the two systems fight each other
   * every tick and starve the event loop.
   */
  preferredOffhand() {
    const bot = this.bot;
    const hasTotem = bot.inventory.items().some((i) => i.name === 'totem_of_undying');
    if (hasTotem && bot.health <= 7) return 'totem_of_undying';
    return 'shield';
  }

  async tick() {
    const bot = this.bot;
    if (!bot.entity || this.suspended || bot.health == null) return;
    // physicsTick fires 20x/s; without a mutex these handlers pile up and the
    // whole bot stalls behind a queue of half-finished equips.
    if (this._ticking) return;
    this._ticking = true;
    try {
      await this.tickInner();
    } finally {
      this._ticking = false;
    }
  }

  async tickInner() {
    const bot = this.bot;

    // 0. Clear panic once the situation actually resolves. Without this a
    //    one-off scare (spawning in water) leaves her flagged as panicking
    //    for minutes and suppresses her combat.
    if (this.panic && bot.health > this.hpFloor + 2 && !standingDanger(bot) && hostilesNear(bot, 6).length === 0) {
      this.exitPanic();
    }

    // 1. Creeper in blast range. Checked first because it is the fastest killer
    //    in the game and the one that catches every naive bot.
    await this.creeperCheck();

    // 2. Standing in something that kills.
    const danger = standingDanger(bot);
    if (danger) {
      if (danger === 'lava' || danger === 'magma') await this.clutch.lavaClutch();
      else await this.escapeDanger(danger);
      return;
    }

    // 3. The full clutch chain: totem, web, burial, drowning, fall saves,
    //    gapple, milk, loot stash, wall-off.
    await this.clutch.evaluate();

    // 4. Food. Eat early and never at zero.
    await this.eatCheck();

    // 5. Shield discipline against arrows and blasts.
    await this.shieldCheck();
  }

  /**
   * Creeper handling is distance-based rather than metadata-based on purpose:
   * fuse metadata indices shift between protocol versions, but 3.5 blocks is
   * 3.5 blocks in every version. Version-proof beats clever.
   */
  async creeperCheck() {
    const bot = this.bot;
    if (Date.now() < this._creeperCooldown) return;
    const creepers = hostilesNear(bot, 6).filter((h) => h.name === 'creeper');
    if (!creepers.length) return;
    const closest = creepers[0];
    if (closest.distance > 3.6) return;
    this._creeperCooldown = Date.now() + 1200;
    this.emit('creeper', closest.entity);
    await this.clutch.creeperClutch(closest.entity);
  }

  async escapeDanger(kind) {
    const bot = this.bot;
    if (this.escaping) return;
    this.escaping = true;
    this.enterPanic(kind);
    try {
      if (kind === 'drowning') {
        await this.swimToLand();
      } else if (kind === 'lava' || kind === 'fire' || kind === 'magma') {
        // Sprint-jump to the nearest safe solid block, away from the source.
        const safe = this.nearestSafeSpot();
        if (safe) await bot.lookAt(safe, true).catch(() => {});
        bot.setControlState('sprint', true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        await this.wait(900);
        bot.setControlState('jump', false);
        bot.setControlState('forward', false);
        bot.setControlState('sprint', false);
        // Water bucket beats burning to death.
        if (kind === 'lava' && bot.health < 12) await this.useWaterBucket();
      } else if (kind === 'powder_snow') {
        bot.setControlState('jump', true);
        await this.wait(600);
        bot.setControlState('jump', false);
      }
    } finally {
      this.escaping = false;
    }
  }

  /**
   * Drowning. Surfacing is not enough — treading water forever means she can't
   * fight, mine or eat properly. She swims to actual dry land and gets out.
   */
  async swimToLand() {
    const bot = this.bot;
    // Float first, always. Air before anything else.
    bot.setControlState('jump', true);
    await bot.lookAt(bot.entity.position.offset(0, 4, 0), true).catch(() => {});

    // Taking the pathfinder cancels any path a skill is currently walking, so only
    // do it when she is genuinely submerged and losing air.
    if (!bot.entity.isInWater) {
      bot.setControlState('jump', false);
      return;
    }

    const land = this.nearestDryLand();
    if (land) {
      /**
       * Swim out using raw controls, NOT the pathfinder.
       *
       * Calling pathfinder.setGoal here cancelled whatever path a skill was walking,
       * and every cancellation surfaced as "the goal was changed before it could be
       * completed". On a live server this is what made "come here" and "follow me"
       * fail over and over near water: the reflex layer and the skill layer were
       * fighting for the same steering wheel. The reflex now steers manually and never
       * touches the shared pathfinder.
       */
      log.reflex(`swimming to land at ${land.x},${land.y},${land.z}`);
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        if (!bot.entity.isInWater && bot.entity.onGround) break;
        await bot.lookAt(land.offset(0.5, 0.5, 0.5), true).catch(() => {});
        bot.setControlState('forward', true);
        bot.setControlState('jump', true); // keeps her swimming up and afloat
        bot.setControlState('sprint', true);
        await this.wait(250);
      }
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
      bot.setControlState('sprint', false);
    } else {
      // Nothing dry in range: keep swimming up and forward.
      bot.setControlState('forward', true);
      await this.wait(900);
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
    }
  }

  /**
   * Nearest spot she can stand on with air above it.
   * Uses the engine's indexed block search rather than a hand-rolled triple loop —
   * the loop version was both slower and too short-ranged to find a shoreline.
   */
  nearestDryLand(radius = 40) {
    const bot = this.bot;
    let candidates = [];
    try {
      candidates = bot.findBlocks({
        matching: (b) => b && b.boundingBox === 'block' && !/water|lava|ice|kelp|seagrass/.test(b.name),
        maxDistance: radius,
        count: 80,
      });
    } catch {
      return null;
    }
    for (const pos of candidates) {
      const feet = bot.blockAt(pos.offset(0, 1, 0));
      const head = bot.blockAt(pos.offset(0, 2, 0));
      if (!feet || !head) continue;
      if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') continue;
      if (/water|lava/.test(feet.name) || /water|lava/.test(head.name)) continue;
      return pos.offset(0, 1, 0);
    }
    return null;
  }

  nearestSafeSpot() {
    const bot = this.bot;
    const p = bot.entity.position.floored();
    let best = null;
    let bestD = Infinity;
    for (let dx = -6; dx <= 6; dx++) {
      for (let dz = -6; dz <= 6; dz++) {
        for (let dy = -2; dy <= 2; dy++) {
          const base = p.offset(dx, dy, dz);
          const floor = bot.blockAt(base.offset(0, -1, 0));
          const feet = bot.blockAt(base);
          const head = bot.blockAt(base.offset(0, 1, 0));
          if (!floor || !feet || !head) continue;
          if (floor.boundingBox !== 'block') continue;
          if (/lava|fire|magma/.test(floor.name)) continue;
          if (feet.boundingBox !== 'empty' || head.boundingBox !== 'empty') continue;
          if (/lava|fire/.test(feet.name) || /lava|fire/.test(head.name)) continue;
          const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 2;
          if (d < bestD) {
            bestD = d;
            best = base;
          }
        }
      }
    }
    return best;
  }

  async useWaterBucket() {
    const bot = this.bot;
    const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket');
    if (!bucket) return false;
    try {
      await bot.equip(bucket, 'hand');
      await bot.lookAt(bot.entity.position.offset(0, -1, 0), true);
      bot.activateItem();
      await this.wait(150);
      bot.deactivateItem();
      return true;
    } catch {
      return false;
    }
  }

  bestFood(desperate = false) {
    const items = this.bot.inventory.items();
    const pool = desperate ? [...GOOD_FOOD, ...DESPERATE_FOOD] : GOOD_FOOD;
    for (const name of pool) {
      if (NEVER_EAT.includes(name)) continue;
      const it = items.find((i) => i.name === name);
      if (it) return it;
    }
    return null;
  }

  /**
   * Eat at 17/20, not at 2/20. Saturation regenerates health;
   * waiting until starving is how bots die to a single zombie.
   */
  async eatCheck() {
    const bot = this.bot;
    if (this.eating) return;
    if (Date.now() - this.lastEat < 2500) return;

    const hurt = bot.health < 19;
    const threshold = hurt ? 19 : 17;
    if (bot.food >= threshold) return;

    const starving = bot.food <= 6;
    const hostileClose = hostilesNear(bot, 5).length > 0;
    // Don't stand there chewing while something is hitting her, unless she's starving.
    if (hostileClose && !starving && bot.health > 12) return;

    const food = this.bestFood(starving);
    if (!food) {
      if (starving) this.emit('starving');
      return;
    }

    this.eating = true;
    const previous = bot.heldItem;
    try {
      await bot.equip(food, 'hand');
      await bot.consume();
      log.reflex(`ate ${food.name} (food ${bot.food}/20)`);
      this.lastEat = Date.now();
      if (previous && previous.name !== food.name) {
        const still = bot.inventory.items().find((i) => i.name === previous.name);
        if (still) await bot.equip(still, 'hand').catch(() => {});
      }
    } catch (err) {
      log.debug(`eat failed: ${err.message}`);
      this.lastEat = Date.now();
    } finally {
      this.eating = false;
    }
  }

  /** Raise the shield when arrows are incoming or she's badly hurt. */
  async shieldCheck() {
    const bot = this.bot;
    // The totem owns the off-hand while she is one hit from dead. Don't contest it.
    if (this.preferredOffhand() === 'totem_of_undying') {
      if (this.blocking) {
        this.blocking = false;
        bot.deactivateItem();
      }
      return;
    }
    if (bot.inventory.slots[45]?.name !== 'shield') {
      await equipShield(bot).catch(() => {});
      return;
    }
    const shooters = hostilesNear(bot, 18).filter((h) => /skeleton|stray|bogged|pillager|blaze|ghast|witch/.test(h.name));
    const shouldBlock = (shooters.length > 0 && bot.health < 16) || (this.panic && hostilesNear(bot, 6).length > 0);

    if (shouldBlock && !this.blocking) {
      this.blocking = true;
      bot.activateItem(true); // off-hand
    } else if (!shouldBlock && this.blocking) {
      this.blocking = false;
      bot.deactivateItem();
    }
  }

  /**
   * Eat deliberately, right now, taking whatever is available including raw meat.
   *
   * The passive eatCheck is fussy on purpose: it only touches raw or rotten food when
   * actually starving, which is correct for routine grazing. But when the goal is to
   * heal, refusing to eat raw beef at 10 food means regeneration never starts — and
   * a soak run logged 26 heals failing with "food too low" while she was carrying
   * meat the whole time.
   */
  async forceEat() {
    const bot = this.bot;
    if (this.eating) return false;
    if (bot.food >= 19) return false;
    const food = this.bestFood(true);
    if (!food) return false;

    this.eating = true;
    const previous = bot.heldItem;
    try {
      await bot.equip(food, 'hand');
      await bot.consume();
      this.lastEat = Date.now();
      log.reflex(`force-ate ${food.name} to start regenerating (food ${bot.food}/20)`);
      if (previous && previous.name !== food.name) {
        const still = bot.inventory.items().find((i) => i.name === previous.name);
        if (still) await bot.equip(still, 'hand').catch(() => {});
      }
      return true;
    } catch (err) {
      log.debug(`force eat failed: ${err.message}`);
      return false;
    } finally {
      this.eating = false;
    }
  }

  dropShield() {
    if (this.blocking) {
      this.blocking = false;
      this.bot.deactivateItem();
    }
  }

  wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
