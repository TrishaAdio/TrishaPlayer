/**
 * CLUTCH SYSTEM
 *
 * Every last-second save a top-tier player has, wired to fire automatically.
 * Nothing in this file may await an LLM. A fatal fall is ~1s of airtime; the totem
 * window is a single tick. All of it is hardcoded, all of it runs at 20 t/s.
 *
 * Each clutch is a small independent routine. A priority chain picks the best one
 * available for the situation from what she is actually carrying.
 */
import { Vec3 } from 'vec3';
import { log } from '../util/log.js';
import { groundBelow, hostilesNear } from '../world/scan.js';

const DOWN = new Vec3(0, -1, 0);
const UP = new Vec3(0, 1, 0);

const item = (bot, name) => bot.inventory.items().find((i) => i.name === name);
const itemAny = (bot, names) => {
  for (const n of names) {
    const it = item(bot, n);
    if (it) return it;
  }
  return null;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const BOATS = ['oak_boat', 'birch_boat', 'spruce_boat', 'jungle_boat', 'acacia_boat', 'dark_oak_boat', 'mangrove_boat', 'cherry_boat', 'bamboo_raft', 'pale_oak_boat'];
const BUILD_BLOCKS = ['cobblestone', 'stone', 'dirt', 'deepslate', 'cobbled_deepslate', 'netherrack', 'oak_planks', 'spruce_planks', 'birch_planks', 'sand', 'gravel', 'andesite', 'granite', 'diorite', 'tuff'];
const AIR_POCKET_BLOCKS = ['oak_door', 'spruce_door', 'birch_door', 'iron_door', 'ladder', 'oak_sign', 'oak_trapdoor', 'oak_fence_gate'];
const HEALS = ['enchanted_golden_apple', 'golden_apple'];

export class Clutch {
  constructor(bot, reflex) {
    this.bot = bot;
    this.reflex = reflex;
    this.busy = false;
    this.lastClutch = { name: null, at: 0 };
    this.stats = {};
    this.armed = new Set();
  }

  mark(name) {
    this.stats[name] = (this.stats[name] || 0) + 1;
    this.lastClutch = { name, at: Date.now() };
    log.reflex(`CLUTCH: ${name}`);
    this.reflex?.emit?.('clutch', name);
  }

  cooling(name, ms) {
    return this.lastClutch.name === name && Date.now() - this.lastClutch.at < ms;
  }

  // ───────────────────────── FALL CLUTCHES ─────────────────────────
  /**
   * Fatal fall in progress. Tries techniques in descending reliability.
   * Water > powder snow > hay > slime > boat > web > twisting vines >
   * ladder grab > block stack > pearl reset > elytra.
   */
  async fallClutch() {
    const bot = this.bot;
    const vy = bot.entity.velocity.y;
    if (bot.entity.onGround || vy > -0.55) {
      this.armed.delete('fall');
      return false;
    }

    const ground = groundBelow(bot, 40);
    const drop = ground.drop;
    // Under 4 blocks is survivable without help.
    if (ground.found && drop <= 4 && !ground.lethal) return false;
    if (ground.water) return false; // already landing in water

    // Elytra first: if she's wearing one, just fly.
    if (bot.inventory.slots[6]?.name === 'elytra' && drop > 8) {
      if (await this.elytraClutch()) return true;
    }

    // The window: fire when close enough that the placement lands under her.
    if (drop > 6) return false;
    if (this.armed.has('fall')) return false;
    this.armed.add('fall');

    const attempts = [
      () => this.waterClutch(),
      () => this.powderSnowClutch(),
      () => this.blockUnderClutch('hay_block', 'hay bale'),
      () => this.blockUnderClutch('slime_block', 'slime block'),
      () => this.boatClutch(),
      () => this.blockUnderClutch('cobweb', 'cobweb'),
      () => this.blockUnderClutch('twisting_vines', 'twisting vines'),
      () => this.pearlClutch(),
      () => this.blockUnderClutch(null, 'block stack'),
    ];
    for (const attempt of attempts) {
      try {
        if (await attempt()) return true;
      } catch {}
    }
    return false;
  }

  /** The classic MLG. Pour water directly beneath, land in it, pick it back up. */
  async waterClutch() {
    const bot = this.bot;
    const bucket = item(bot, 'water_bucket');
    if (!bucket) return false;
    if (bot.game?.dimension === 'the_nether') return false; // water evaporates
    if (bot.heldItem?.name !== 'water_bucket') await bot.equip(bucket, 'hand');
    await bot.lookAt(bot.entity.position.offset(0, -4, 0), true);
    bot.activateItem();
    await wait(90);
    bot.deactivateItem();
    this.mark('MLG water bucket');
    // Scoop it back up so the trick is repeatable.
    setTimeout(() => this.recoverWater().catch(() => {}), 900);
    return true;
  }

  async recoverWater() {
    const bot = this.bot;
    const empty = item(bot, 'bucket');
    if (!empty) return false;
    const water = bot.findBlock({
      matching: (b) => /^water$/.test(b?.name),
      maxDistance: 4,
      count: 1,
    });
    if (!water) return false;
    await bot.equip(empty, 'hand');
    await bot.lookAt(water.position.offset(0.5, 0.5, 0.5), true);
    bot.activateItem();
    await wait(120);
    bot.deactivateItem();
    return true;
  }

  /** Powder snow negates fall damage completely — better than water when available. */
  async powderSnowClutch() {
    const bot = this.bot;
    const bucket = item(bot, 'powder_snow_bucket');
    if (!bucket) return false;
    await bot.equip(bucket, 'hand');
    await bot.lookAt(bot.entity.position.offset(0, -4, 0), true);
    bot.activateItem();
    await wait(90);
    bot.deactivateItem();
    this.mark('powder snow clutch');
    return true;
  }

  /** Boats zero out fall damage on landing. */
  async boatClutch() {
    const bot = this.bot;
    const boat = itemAny(bot, BOATS);
    if (!boat) return false;
    await bot.equip(boat, 'hand');
    await bot.lookAt(bot.entity.position.offset(0, -3, 0), true);
    bot.activateItem();
    await wait(90);
    bot.deactivateItem();
    this.mark('boat clutch');
    return true;
  }

  /** Place a soft/any block into the impact spot. */
  async blockUnderClutch(preferred, label) {
    const bot = this.bot;
    const it = preferred ? item(bot, preferred) : itemAny(bot, BUILD_BLOCKS);
    if (!it) return false;
    const ground = groundBelow(bot, 12);
    if (!ground.found || !ground.block) return false;
    await bot.equip(it, 'hand');
    await bot.lookAt(ground.block.position.offset(0.5, 1, 0.5), true);
    try {
      await bot.placeBlock(ground.block, UP);
      this.mark(`${label} clutch`);
      return true;
    } catch {
      return false;
    }
  }

  /** Pearl teleport resets fall distance. Ugly, effective. */
  async pearlClutch() {
    const bot = this.bot;
    const pearl = item(bot, 'ender_pearl');
    if (!pearl) return false;
    const ground = groundBelow(bot, 40);
    if (!ground.block) return false;
    await bot.equip(pearl, 'hand');
    await bot.lookAt(ground.block.position.offset(0.5, 1, 0.5), true);
    bot.activateItem();
    await wait(80);
    bot.deactivateItem();
    this.mark('ender pearl fall reset');
    return true;
  }

  async elytraClutch() {
    const bot = this.bot;
    try {
      if (!bot.elytraFly && !bot.entity.elytraFlying) {
        bot.setControlState('jump', false);
        await wait(30);
        if (typeof bot.elytraFly === 'function') await bot.elytraFly();
        else bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 8, jumpBoost: 0 });
        const rocket = item(bot, 'firework_rocket');
        if (rocket) {
          await bot.equip(rocket, 'hand');
          bot.activateItem();
          await wait(80);
          bot.deactivateItem();
        }
        this.mark('elytra clutch');
        return true;
      }
    } catch {}
    return false;
  }

  /** Grab a wall mid-fall with a ladder. */
  async ladderClutch() {
    const bot = this.bot;
    const ladder = item(bot, 'ladder');
    if (!ladder) return false;
    const p = bot.entity.position.floored();
    for (const off of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
      const wall = bot.blockAt(p.plus(off));
      if (wall?.boundingBox === 'block') {
        try {
          await bot.equip(ladder, 'hand');
          await bot.placeBlock(wall, off.scaled(-1));
          this.mark('ladder wall grab');
          return true;
        } catch {}
      }
    }
    return false;
  }

  // ───────────────────────── LAVA / FIRE ─────────────────────────
  /** In lava: fire res if she has it, water to cool it, then climb out. */
  async lavaClutch() {
    const bot = this.bot;
    if (this.cooling('lava clutch', 1500)) return false;

    const fireRes = bot.inventory.items().find((i) => /potion/.test(i.name) && /fire/i.test(JSON.stringify(i.nbt || {})));
    if (fireRes && bot.health < 14) {
      try {
        await bot.equip(fireRes, 'hand');
        bot.activateItem();
        await wait(200);
        bot.deactivateItem();
        this.mark('fire resistance clutch');
      } catch {}
    }

    // Water on lava makes stone/obsidian to stand on (overworld only).
    const bucket = item(bot, 'water_bucket');
    if (bucket && bot.game?.dimension !== 'the_nether') {
      try {
        await bot.equip(bucket, 'hand');
        await bot.lookAt(bot.entity.position.offset(0, 0.2, 0), true);
        bot.activateItem();
        await wait(120);
        bot.deactivateItem();
        this.mark('lava clutch (water)');
      } catch {}
    }

    // Swim up and out regardless.
    bot.setControlState('jump', true);
    bot.setControlState('forward', true);
    bot.setControlState('sprint', false);
    await wait(700);
    bot.setControlState('jump', false);
    bot.setControlState('forward', false);
    this.mark('lava clutch');
    return true;
  }

  // ───────────────────────── CREEPER ─────────────────────────
  /**
   * Creeper inside blast range. Three answers, best first:
   *  1. knock it away with a sweeping/knockback hit, then step out
   *  2. hard-block with the shield and eat the reduced damage
   *  3. sprint out of the 3.5 block radius
   */
  async creeperClutch(creeper) {
    const bot = this.bot;
    if (this.busy) return false;
    this.busy = true;
    try {
      const dist = bot.entity.position.distanceTo(creeper.position);
      const away = bot.entity.position.minus(creeper.position).normalize();

      if (dist < 2.6) {
        // Too close to run — hit it away, then disengage.
        try {
          await bot.lookAt(creeper.position.offset(0, 1.2, 0), true);
          bot.attack(creeper);
        } catch {}
      }

      const hasShield = bot.inventory.slots[45]?.name === 'shield';
      if (hasShield && dist < 3.2) {
        bot.activateItem(true);
        this.reflex.blocking = true;
      }

      // Back out of blast radius.
      await bot.lookAt(bot.entity.position.plus(away.scaled(6)), true);
      bot.setControlState('sprint', true);
      bot.setControlState('forward', true);
      await wait(700);
      bot.setControlState('forward', false);
      bot.setControlState('sprint', false);

      if (this.reflex.blocking) {
        bot.deactivateItem();
        this.reflex.blocking = false;
      }
      this.mark('creeper dodge');
      return true;
    } finally {
      this.busy = false;
    }
  }

  // ───────────────────────── TOTEM ─────────────────────────
  /** Totem of undying into the off-hand the instant she's in kill range. */
  async totemClutch() {
    const bot = this.bot;
    const totem = item(bot, 'totem_of_undying');
    if (!totem) return false;
    if (bot.inventory.slots[45]?.name === 'totem_of_undying') return false;
    if (bot.health > 7) return false;
    // Don't retry every tick if the equip is being rejected — that floods the
    // event loop and she stops fighting entirely.
    if (this.cooling('totem in off-hand', 2500) || this._totemBusy) return false;
    this._totemBusy = true;
    try {
      await bot.equip(totem, 'off-hand');
      if (bot.inventory.slots[45]?.name === 'totem_of_undying') {
        this.mark('totem in off-hand');
        return true;
      }
      this.lastClutch = { name: 'totem in off-hand', at: Date.now() }; // start the cooldown anyway
      return false;
    } catch {
      this.lastClutch = { name: 'totem in off-hand', at: Date.now() };
      return false;
    } finally {
      this._totemBusy = false;
    }
  }

  // ───────────────────────── HEALING ─────────────────────────
  /** Gapple / healing potion / milk under pressure. */
  async healClutch() {
    const bot = this.bot;
    if (bot.health > 8) return false;
    if (this.cooling('heal clutch', 3000)) return false;

    const gap = itemAny(bot, HEALS);
    if (gap) {
      try {
        const prev = bot.heldItem;
        await bot.equip(gap, 'hand');
        await bot.consume();
        this.mark('heal clutch');
        if (prev) await bot.equip(prev, 'hand').catch(() => {});
        return true;
      } catch {}
    }
    const potion = bot.inventory.items().find((i) => i.name === 'potion' && /healing|regen/i.test(JSON.stringify(i.nbt || {})));
    if (potion) {
      try {
        await bot.equip(potion, 'hand');
        bot.activateItem();
        await wait(200);
        bot.deactivateItem();
        this.mark('heal clutch');
        return true;
      } catch {}
    }
    return false;
  }

  /** Milk cures poison and wither. */
  async milkClutch() {
    const bot = this.bot;
    const milk = item(bot, 'milk_bucket');
    if (!milk) return false;
    const bad = Object.keys(bot.entity?.effects || {}).length > 0;
    if (!bad) return false;
    try {
      await bot.equip(milk, 'hand');
      await bot.consume();
      this.mark('milk clutch');
      return true;
    } catch {
      return false;
    }
  }

  // ───────────────────────── WALL OFF ─────────────────────────
  /**
   * Overwhelmed and losing. Seal herself in a 1x2 cobble pocket, heal, come back out.
   * The oldest survival trick and still the best.
   */
  async wallOffClutch() {
    const bot = this.bot;
    const blocks = itemAny(bot, BUILD_BLOCKS);
    if (!blocks) return false;
    if (this.cooling('wall off', 8000)) return false;
    this.busy = true;
    try {
      await bot.equip(blocks, 'hand');
      const p = bot.entity.position.floored();
      const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
      let placed = 0;
      for (const dy of [0, 1]) {
        for (const off of sides) {
          const target = p.offset(off.x, dy, off.z);
          const existing = bot.blockAt(target);
          if (existing && existing.boundingBox === 'block') continue;
          const ref = bot.blockAt(target.offset(0, -1, 0));
          if (!ref || ref.boundingBox !== 'block') continue;
          try {
            await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
            await bot.placeBlock(ref, UP);
            placed++;
          } catch {}
        }
      }
      // Cap it so nothing drops in on her.
      const above = bot.blockAt(p.offset(0, 2, 0));
      if (above && above.boundingBox === 'empty') {
        const side = bot.blockAt(p.offset(1, 2, 0));
        if (side?.boundingBox === 'block') {
          try {
            await bot.placeBlock(side, new Vec3(-1, 0, 0));
            placed++;
          } catch {}
        }
      }
      if (placed) {
        this.mark('wall off');
        return true;
      }
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** Buried by gravel/sand, or walled in — dig out upward. */
  async buriedClutch() {
    const bot = this.bot;
    const head = bot.blockAt(bot.entity.position.offset(0, 1, 0));
    if (!head || head.boundingBox !== 'block') return false;
    if (!/gravel|sand|concrete_powder|dirt|snow/.test(head.name)) return false;
    try {
      await bot.dig(head);
      this.mark('dig out of burial');
      return true;
    } catch {
      return false;
    }
  }

  /** Air pocket while drowning: a door/ladder/sign holds breathable space. */
  async airPocketClutch() {
    const bot = this.bot;
    if ((bot.oxygenLevel ?? 20) > 6) return false;
    const b = itemAny(bot, AIR_POCKET_BLOCKS);
    if (!b) return false;
    const p = bot.entity.position.floored();
    for (const off of [new Vec3(1, 1, 0), new Vec3(-1, 1, 0), new Vec3(0, 1, 1), new Vec3(0, 1, -1)]) {
      const wall = bot.blockAt(p.plus(off).offset(0, -1, 0));
      if (wall?.boundingBox === 'block') {
        try {
          await bot.equip(b, 'hand');
          await bot.placeBlock(wall, UP);
          this.mark('air pocket clutch');
          return true;
        } catch {}
      }
    }
    return false;
  }

  /** Stuck in a cobweb — break out instead of standing there being shot. */
  async webClutch() {
    const bot = this.bot;
    const here = bot.blockAt(bot.entity.position.floored());
    if (here?.name !== 'cobweb') return false;
    const sword = bot.inventory.items().find((i) => /sword|shears/.test(i.name));
    try {
      if (sword) await bot.equip(sword, 'hand');
      await bot.dig(here);
      this.mark('web escape');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Death looks likely and she's carrying real loot: dump it in an ender chest
   * so the diamonds survive even if she doesn't.
   */
  async stashClutch() {
    const bot = this.bot;
    const ender = item(bot, 'ender_chest');
    const valuables = bot.inventory.items().filter((i) => /diamond|netherite|ancient_debris|emerald|totem|elytra|enchanted/.test(i.name));
    if (!ender || !valuables.length) return false;
    if (bot.health > 6) return false;
    if (this.cooling('loot stash', 20000)) return false;
    try {
      const p = bot.entity.position.floored();
      const ref = bot.blockAt(p.offset(0, -1, 0));
      if (!ref || ref.boundingBox !== 'block') return false;
      await bot.equip(ender, 'hand');
      await bot.placeBlock(ref, UP);
      const placed = bot.blockAt(p);
      const chest = await bot.openContainer(placed);
      for (const v of valuables) {
        await chest.deposit(v.type, null, v.count).catch(() => {});
      }
      chest.close();
      this.mark('loot stash');
      return true;
    } catch {
      return false;
    }
  }

  /** About to walk off into the void / a ravine — place a block behind and step back. */
  async ledgeClutch() {
    const bot = this.bot;
    if (!bot.entity.onGround) return false;
    const ground = groundBelow(bot, 30);
    if (ground.found && ground.drop <= 4) return false;
    bot.setControlState('forward', false);
    bot.setControlState('sprint', false);
    bot.setControlState('back', true);
    await wait(220);
    bot.setControlState('back', false);
    this.mark('ledge stop');
    return true;
  }

  /**
   * Main entry, called by the reflex tick. Ordered by how dead she is.
   */
  async evaluate() {
    const bot = this.bot;
    if (!bot.entity || this.busy) return;

    // Totem first — it is the only thing that works after the killing blow.
    if (bot.health <= 7) await this.totemClutch();

    if (await this.webClutch()) return;
    if (await this.buriedClutch()) return;
    if (await this.airPocketClutch()) return;
    if (await this.fallClutch()) return;
    if (await this.healClutch()) return;
    await this.milkClutch();

    if (bot.health <= 6) {
      if (await this.stashClutch()) return;
      const swarm = hostilesNear(bot, 6).length;
      if (swarm >= 2 && (await this.wallOffClutch())) return;
    }
  }

  summary() {
    const entries = Object.entries(this.stats);
    if (!entries.length) return 'no clutches yet';
    return entries.map(([k, v]) => `${k} x${v}`).join(', ');
  }
}
