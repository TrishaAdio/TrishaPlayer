/**
 * THE ACTION REGISTRY — the contract between her brain and her body.
 *
 * Everything she can physically do lives here, exactly once. The brain may only
 * emit these names. Unknown names and bad arguments are rejected with a readable
 * reason and fed back, so a confused model produces a correction rather than a crash.
 *
 * One action runs at a time and every one is cancellable, which is what makes
 * "trisha come here" able to interrupt a diamond run mid-swing.
 */
import { log } from './util/log.js';
import { Task, AbortError } from './task.js';
import { config } from './config.js';
import { mem } from './world/memory.js';

import * as move from './skills/move.js';
import * as gather from './skills/gather.js';
import * as craftSkills from './skills/craft.js';
import * as build from './skills/build.js';
import * as farm from './skills/farm.js';
import * as storage from './skills/storage.js';
import * as misc from './skills/misc.js';
import * as enchant from './skills/enchant.js';
import * as nether from './skills/nether.js';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v, d = '') => (v == null ? d : String(v));

/**
 * name: { group, needs, run(ctx, args), describe }
 * `run` gets { bot, task, combat, targeting, reflex, brain, flags }
 */
export const ACTIONS = {
  // ── movement ───────────────────────────────────────────────
  goto: {
    group: 'move',
    describe: 'goto{x,y,z} walk to coordinates',
    run: ({ bot, task }, a) => move.goTo(bot, task, num(a.x, bot.entity.position.x), num(a.y, bot.entity.position.y), num(a.z, bot.entity.position.z), { range: num(a.range, 1) }),
  },
  come: {
    group: 'move',
    describe: 'come{} walk to the owner',
    run: ({ bot, task }, a) => move.come(bot, task, { range: num(a.range, 2) }),
  },
  follow: {
    group: 'move',
    describe: 'follow{player,distance} tail a player until told otherwise',
    run: ({ bot, task }, a) => move.follow(bot, task, { player: str(a.player, config.owner), distance: num(a.distance ?? a.dist, 3), durationMs: num(a.seconds, 0) * 1000 }),
  },
  flee: {
    group: 'move',
    describe: 'flee{from,distance} run away',
    run: ({ bot, task, targeting }, a) => {
      const from = a.from ? targeting.resolve(Array.isArray(a.from) ? a.from[0] : a.from) : targeting.pick();
      return move.flee(bot, task, { from, distance: num(a.distance, 20) });
    },
  },
  explore: {
    group: 'move',
    describe: 'explore{radius} wander to find new terrain',
    run: ({ bot, task }, a) => move.explore(bot, task, { radius: num(a.radius, 80) }),
  },
  home: {
    group: 'move',
    describe: 'home{} return to base',
    run: ({ bot, task }) => move.goHome(bot, task),
  },
  waypoint: {
    group: 'move',
    describe: 'waypoint{name} go to a saved waypoint',
    run: ({ bot, task }, a) => move.gotoWaypoint(bot, task, { name: str(a.name) }),
  },

  // ── gathering ──────────────────────────────────────────────
  mine: {
    group: 'gather',
    describe: 'mine{block,count} mine a block type, follows the whole vein',
    run: ({ bot, task }, a) => gather.mine(bot, task, { block: str(a.block ?? a.ore ?? a.item), count: num(a.count, 1), optional: !!a.optional }),
  },
  chopWood: {
    group: 'gather',
    describe: 'chopWood{count} fell trees',
    run: ({ bot, task }, a) => gather.chopWood(bot, task, { count: num(a.count, 8) }),
  },
  collectDrops: {
    group: 'gather',
    describe: 'collectDrops{radius} pick up nearby items',
    run: ({ bot, task }, a) => gather.collectDrops(bot, task, { radius: num(a.radius, 12) }),
  },
  digDown: {
    group: 'gather',
    describe: 'digDown{toY} staircase down to a Y level',
    run: ({ bot, task }, a) => gather.digDown(bot, task, { toY: num(a.toY ?? a.y, 16) }),
  },
  branchMine: {
    group: 'gather',
    describe: 'branchMine{targetY,ore,count} proper mining trip at depth',
    run: ({ bot, task }, a) =>
      gather.branchMine(bot, task, {
        targetY: num(a.targetY ?? a.y, config.ladder.diamondY),
        ore: str(a.ore ?? a.block, 'diamond_ore'),
        count: num(a.count, 8),
        lavaCaution: a.lavaCaution !== false,
      }),
  },

  // ── crafting ───────────────────────────────────────────────
  craft: {
    group: 'craft',
    describe: 'craft{item,count} craft anything, resolves sub-recipes',
    run: ({ bot, task }, a) => craftSkills.craft(bot, task, { item: str(a.item ?? a.block), count: num(a.count, 1), optional: !!a.optional }),
  },
  smelt: {
    group: 'craft',
    describe: 'smelt{item,count} cook or smelt in a furnace',
    run: ({ bot, task }, a) => craftSkills.smelt(bot, task, { item: str(a.item), count: num(a.count, 1), any: a.any }),
  },
  equipBest: {
    group: 'craft',
    describe: 'equipBest{} wear the best armour and hold the best weapon',
    run: ({ bot }) => misc.equipBestAction(bot),
  },

  // ── building ───────────────────────────────────────────────
  shelter: {
    group: 'build',
    describe: 'shelter{} emergency mob-proof hole, fast',
    run: ({ bot, task }) => build.shelter(bot, task, {}),
  },
  base: {
    group: 'build',
    describe: 'base{size} build a real house with door, windows, light, chest and bed',
    run: ({ bot, task }, a) => build.buildBase(bot, task, { size: num(a.size, 7), near: str(a.near, 'here') }),
  },
  bridge: {
    group: 'build',
    describe: 'bridge{x,y,z} bridge across a gap',
    run: ({ bot, task }, a) => build.bridgeTo(bot, task, { x: num(a.x, 0), y: num(a.y, 0), z: num(a.z, 0) }),
  },
  pillarUp: {
    group: 'build',
    describe: 'pillarUp{height} tower straight up',
    run: ({ bot, task }, a) => build.pillarUp(bot, task, { height: num(a.height, 8) }),
  },
  placeBlock: {
    group: 'build',
    describe: 'placeBlock{block,x,y,z} place one block',
    run: ({ bot, task }, a) => build.placeBlockAt(bot, task, { block: str(a.block), x: num(a.x, 0), y: num(a.y, 0), z: num(a.z, 0) }),
  },
  lightArea: {
    group: 'build',
    describe: 'lightArea{radius} torch the area so nothing spawns',
    run: ({ bot, task }, a) => build.lightArea(bot, task, { radius: num(a.radius, 8) }),
  },
  markHome: {
    group: 'build',
    describe: 'markHome{} remember this spot as home',
    run: ({ bot, task }) => build.markHome(bot, task),
  },

  // ── combat ─────────────────────────────────────────────────
  attack: {
    group: 'combat',
    describe: 'attack{target} kill something — mob name, player name, or "nearest"',
    run: async ({ bot, task, combat, targeting }, a) => {
      const wanted = a.target ?? a.entity ?? a.mob ?? a.name ?? 'nearest';
      const target = targeting.resolve(wanted) || targeting.pick();
      if (!target) return { ok: false, reason: `nothing here matching "${wanted}"` };
      if (target.username === config.owner) return { ok: false, reason: 'not attacking my own player' };
      targeting.setManual(target);
      try {
        return await combat.fight(target, { timeoutMs: num(a.timeoutMs, 90000) });
      } finally {
        targeting.clearManual();
      }
    },
  },
  defend: {
    group: 'combat',
    describe: 'defend{player} guard a player and kill whatever attacks them',
    run: async ({ bot, task, combat, targeting }, a) => {
      const who = str(a.player, config.owner);
      const guardFor = num(a.seconds, 60) * 1000;
      const started = Date.now();
      let fights = 0;
      while (!task.aborted && Date.now() - started < guardFor) {
        const threat = targeting.pick({ maxDistance: 16 });
        if (threat) {
          fights++;
          await combat.fight(threat, { timeoutMs: 30000, pursue: false });
        } else {
          const owner = bot.players[who]?.entity;
          if (owner && bot.entity.position.distanceTo(owner.position) > 6) {
            await move.come(bot, task, { range: 3 }).catch(() => {});
          } else {
            await task.sleep(600);
          }
        }
      }
      return { ok: true, detail: `guarded ${who}, ${fights} fights` };
    },
  },
  duel: {
    group: 'combat',
    describe: 'duel{player} full PvP against a player',
    run: async ({ combat, targeting }, a) => {
      const target = targeting.resolve(str(a.player ?? a.target));
      if (!target) return { ok: false, reason: `cannot see ${a.player ?? a.target}` };
      if (target.username === config.owner) return { ok: false, reason: 'never against my own player' };
      return combat.duel(target);
    },
  },
  hunt: {
    group: 'combat',
    describe: 'hunt{mob,count} seek out and kill a mob type',
    run: async ({ bot, task, combat, targeting }, a) => {
      const mob = str(a.mob ?? a.target, 'zombie');
      const want = num(a.count, 1);
      let killed = 0;
      for (let i = 0; i < want * 3 && killed < want && !task.aborted; i++) {
        const target = targeting.resolve(mob);
        if (!target) {
          await move.explore(bot, task, { radius: 48 }).catch(() => {});
          continue;
        }
        const res = await combat.fight(target, { timeoutMs: 45000 });
        if (res.killed) killed++;
      }
      return { ok: killed > 0, detail: `killed ${killed}x ${mob}`, got: killed };
    },
  },
  shoot: {
    group: 'combat',
    describe: 'shoot{target,shots} bow work with target leading',
    run: async ({ combat, targeting }, a) => {
      const target = targeting.resolve(str(a.target, 'nearest')) || targeting.pick();
      if (!target) return { ok: false, reason: 'nothing to shoot' };
      return combat.shoot(target, { shots: num(a.shots, 3) });
    },
  },
  retreat: {
    group: 'combat',
    describe: 'retreat{} break off, heal, get to safety',
    run: async ({ bot, task, combat, targeting, reflex }) => {
      combat.stop();
      const threat = targeting.pick({ maxDistance: 12 });
      await combat.disengage(threat);
      await reflex.eatCheck().catch(() => {});
      if (mem.all.base && bot.health < 10) await move.goHome(bot, task).catch(() => {});
      return { ok: true, detail: 'disengaged' };
    },
  },

  // ── survival ───────────────────────────────────────────────
  eat: {
    group: 'survive',
    describe: 'eat{} eat the best food she has',
    run: async ({ bot, reflex }) => {
      const before = bot.food;
      await reflex.eatCheck();
      return { ok: bot.food >= before, detail: `food ${bot.food}/20` };
    },
  },
  sleep: {
    group: 'survive',
    describe: 'sleep{} sleep in a bed to skip the night',
    run: ({ bot, task }) => misc.sleepNow(bot, task),
  },
  heal: {
    group: 'survive',
    describe: 'heal{} gapple or potion, then wait to regenerate',
    run: async ({ bot, task, reflex }) => {
      await reflex.clutch.healClutch();
      // Regeneration needs a near-full food bar. With nothing to eat, waiting here
      // does nothing at all, so say so instead of blocking for 40 seconds.
      const hasFood = !!reflex.bestFood(true);
      const hasPotion = bot.inventory.items().some((i) => /golden_apple|^potion$/.test(i.name));
      if (!hasFood && !hasPotion && bot.food < 18) {
        return { ok: false, reason: 'nothing to heal with — need food' };
      }
      let guard = 0;
      const startHp = bot.health;
      while (bot.health < 18 && guard++ < 40 && !task.aborted) {
        await reflex.eatCheck().catch(() => {});
        await task.sleep(1000);
        if (guard > 8 && bot.health <= startHp && bot.food < 18) {
          return { ok: false, reason: 'not regenerating — food too low' };
        }
      }
      return { ok: true, detail: `hp ${Math.round(bot.health)}/20` };
    },
  },

  // ── food ───────────────────────────────────────────────────
  getFood: {
    group: 'farm',
    describe: 'getFood{count} hunt, forage and cook food',
    run: ({ bot, task }, a) => farm.forageFood(bot, task, { target: num(a.count ?? a.target, 8), urgent: !!a.urgent }),
  },
  forageFood: {
    group: 'farm',
    describe: 'alias of getFood',
    run: ({ bot, task }, a) => farm.forageFood(bot, task, { target: num(a.count ?? a.target, 8), urgent: !!a.urgent }),
  },
  butcher: {
    group: 'farm',
    describe: 'butcher{animal,count} kill livestock for meat',
    run: ({ bot, task }, a) => farm.butcher(bot, task, { animal: str(a.animal, 'any'), count: num(a.count, 2) }),
  },
  farmCrops: {
    group: 'farm',
    describe: 'farmCrops{crop,plots} till and plant a crop field',
    run: ({ bot, task }, a) => farm.farmCrops(bot, task, { crop: str(a.crop, 'wheat'), plots: num(a.plots, 12) }),
  },
  harvest: {
    group: 'farm',
    describe: 'harvest{} harvest ripe crops and replant',
    run: ({ bot, task }, a) => farm.harvestCrops(bot, task, { radius: num(a.radius, 32) }),
  },
  fish: {
    group: 'farm',
    describe: 'fish{count} catch fish',
    run: ({ bot, task }, a) => farm.fish(bot, task, { count: num(a.count, 4) }),
  },

  // ── storage ────────────────────────────────────────────────
  deposit: {
    group: 'storage',
    describe: 'deposit{keep} store loot in a chest',
    run: ({ bot, task }, a) => storage.deposit(bot, task, { keep: str(a.keep, 'gear,food,torch,blocks'), items: a.items }),
  },
  withdraw: {
    group: 'storage',
    describe: 'withdraw{item,count} take from a chest',
    run: ({ bot, task }, a) => storage.withdraw(bot, task, { item: str(a.item), count: num(a.count, 1) }),
  },
  give: {
    group: 'storage',
    describe: 'give{player,item,count} hand items to a player',
    run: ({ bot, task }, a) => storage.give(bot, task, { player: str(a.player, config.owner), item: str(a.item), count: num(a.count, 1) }),
  },
  drop: {
    group: 'storage',
    describe: 'drop{item,count} throw items on the ground',
    run: ({ bot, task }, a) => storage.dropItem(bot, task, { item: str(a.item), count: num(a.count, 1) }),
  },
  fillBucket: {
    group: 'storage',
    describe: 'fillBucket{fluid} fill a bucket (water for MLG clutches)',
    run: ({ bot, task }, a) => misc.fillBucket(bot, task, { fluid: str(a.fluid, 'water') }),
  },

  // ── endgame ────────────────────────────────────────────────
  getObsidian: {
    group: 'endgame',
    describe: 'getObsidian{count} mine obsidian, or cast it by pouring water on lava',
    run: ({ bot, task }, a) => enchant.getObsidian(bot, task, { count: num(a.count, 10) }),
  },
  makeBooks: {
    group: 'endgame',
    describe: 'makeBooks{count} sugar cane to paper, cows to leather, then books',
    run: ({ bot, task }, a) => enchant.makeBooks(bot, task, { count: num(a.count, 15) }),
  },
  bookshelves: {
    group: 'endgame',
    describe: 'bookshelves{count} build the bookshelf ring that unlocks level 30 enchants',
    run: ({ bot, task }, a) => enchant.buildBookshelves(bot, task, { count: num(a.count, 15) }),
  },
  xpGrind: {
    group: 'endgame',
    describe: 'xpGrind{level} mine ore and fight until she hits an XP level',
    run: ({ bot, task }, a) => enchant.xpGrind(bot, task, { level: num(a.level, 30) }),
  },
  enchant: {
    group: 'endgame',
    describe: 'enchant{item} enchant one item at the table',
    run: ({ bot, task }, a) => enchant.enchantItem(bot, task, { item: str(a.item), choice: num(a.choice, 2) }),
  },
  enchantKit: {
    group: 'endgame',
    describe: 'enchantKit{} enchant sword, armour, pickaxe and bow',
    run: ({ bot, task }, a) => enchant.enchantKit(bot, task, { minLevel: num(a.minLevel, 30) }),
  },
  netherPortal: {
    group: 'endgame',
    describe: 'netherPortal{} build and light a nether portal',
    run: ({ bot, task }) => nether.buildNetherPortal(bot, task),
  },
  netherRun: {
    group: 'endgame',
    describe: 'netherRun{debris} portal in, mine ancient debris, come home',
    run: ({ bot, task }, a) => nether.netherRun(bot, task, { debris: num(a.debris, 4) }),
  },
  netheriteIngot: {
    group: 'endgame',
    describe: 'netheriteIngot{count} smelt debris to scrap and craft ingots',
    run: ({ bot, task }, a) => nether.makeNetheriteIngot(bot, task, { count: num(a.count, 1) }),
  },

  // ── meta ───────────────────────────────────────────────────
  idle: {
    group: 'meta',
    describe: 'idle{seconds} wait',
    run: ({ bot, task }, a) => misc.idle(bot, task, { seconds: num(a.seconds, 5) }),
  },
  lookAt: {
    group: 'meta',
    describe: 'lookAt{player} turn to face someone',
    run: ({ bot, task }, a) => misc.lookAtPlayer(bot, task, { player: str(a.player, config.owner) }),
  },
  markReturned: {
    group: 'meta',
    describe: 'markReturned{} note that she made it home with the loot',
    run: ({ flags }) => {
      flags.returnedHome = true;
      return { ok: true, detail: 'home safe' };
    },
  },
  stop: {
    group: 'meta',
    describe: 'stop{} stop what she is doing',
    run: () => ({ ok: true, detail: 'stopped' }),
  },
  say: {
    group: 'meta',
    describe: 'say{} speak only, do nothing physical',
    run: () => ({ ok: true, detail: 'said it' }),
  },
};

/** Catalogue text injected into the brain prompt. */
export function actionCatalogue() {
  const groups = {};
  for (const [name, def] of Object.entries(ACTIONS)) {
    if (def.describe?.startsWith('alias')) continue;
    (groups[def.group] = groups[def.group] || []).push(def.describe || name);
  }
  return Object.entries(groups)
    .map(([g, list]) => `${g}: ${list.join(' | ')}`)
    .join('\n');
}

export function isValidAction(name) {
  return Object.prototype.hasOwnProperty.call(ACTIONS, name);
}

export function actionNames() {
  return Object.keys(ACTIONS);
}

/**
 * Runs one action at a time. Cancelling is instant: the running task's abort flag
 * flips, pathfinder is stopped, combat is halted, and the skill throws out.
 */
export class Executor {
  constructor(ctx) {
    this.ctx = ctx; // { bot, reflex, combat, targeting, flags }
    this.current = null;
    this.currentName = null;
    this.history = [];
  }

  get busy() {
    return !!this.current;
  }

  cancel(reason = 'interrupted') {
    if (this.current) {
      log.act(`cancelling ${this.currentName} (${reason})`);
      this.current.cancel(reason);
      try {
        this.ctx.combat.stop();
      } catch {}
      try {
        move.stopMoving(this.ctx.bot);
      } catch {}
    }
  }

  async run(action) {
    const name = action?.name;
    const args = action?.args && typeof action.args === 'object' ? action.args : {};

    if (!name || typeof name !== 'string') {
      return { ok: false, reason: 'no action name given' };
    }
    const def = ACTIONS[name];
    if (!def) {
      const guess = closestName(name);
      return { ok: false, reason: `"${name}" is not a real action${guess ? `, did you mean ${guess}` : ''}` };
    }

    // Anything new supersedes what she was doing.
    if (this.current) this.cancel(`superseded by ${name}`);

    const task = new Task(name);
    this.current = task;
    this.currentName = name;
    const t0 = Date.now();

    try {
      const result = (await def.run({ ...this.ctx, task }, args)) || { ok: true };
      const record = { name, args, ...result, ms: Date.now() - t0 };
      this.history.unshift(record);
      this.history = this.history.slice(0, 12);
      log.act(`${name} -> ${result.ok ? 'ok' : 'FAILED'}${result.detail ? `: ${result.detail}` : result.reason ? `: ${result.reason}` : ''}`);
      return record;
    } catch (err) {
      if (err instanceof AbortError || err?.aborted) {
        const record = { name, args, ok: false, aborted: true, reason: err.message || 'interrupted', ms: Date.now() - t0 };
        this.history.unshift(record);
        return record;
      }
      log.error(`${name} threw: ${err.message}`);
      const record = { name, args, ok: false, reason: `crashed: ${err.message}`, ms: Date.now() - t0 };
      this.history.unshift(record);
      return record;
    } finally {
      if (this.current === task) {
        this.current = null;
        this.currentName = null;
      }
    }
  }

  recentSummary(n = 4) {
    return this.history
      .slice(0, n)
      .map((h) => `${h.name}: ${h.ok ? 'ok' : 'failed'}${h.detail ? ` (${h.detail})` : h.reason ? ` (${h.reason})` : ''}`)
      .join(' ; ');
  }
}

function closestName(name) {
  const target = String(name).toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const n of Object.keys(ACTIONS)) {
    const a = n.toLowerCase();
    let score = 0;
    if (a.includes(target) || target.includes(a)) score = Math.min(a.length, target.length);
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  return bestScore >= 3 ? best : null;
}
