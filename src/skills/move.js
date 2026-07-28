/**
 * Movement. Everything routes through pathfinder with movement settings tuned for
 * survival: she will not path through lava, will not take a lethal drop, and will
 * bridge or tower when it is the only way.
 */
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { config } from '../config.js';
import { log } from '../util/log.js';
import { mem } from '../world/memory.js';
import { AbortError } from '../task.js';
import { groundBelow } from '../world/scan.js';

const { pathfinder, Movements, goals } = pathfinderPkg;
const { GoalNear, GoalFollow, GoalBlock, GoalXZ, GoalY, GoalLookAtBlock } = goals;

const AVOID = ['lava', 'flowing_lava', 'fire', 'soul_fire', 'cactus', 'magma_block', 'sweet_berry_bush', 'wither_rose', 'powder_snow', 'campfire', 'soul_campfire', 'pointed_dripstone'];
const SCAFFOLD = ['cobblestone', 'dirt', 'stone', 'deepslate', 'cobbled_deepslate', 'netherrack', 'oak_planks', 'spruce_planks', 'birch_planks', 'andesite', 'granite', 'diorite', 'tuff', 'sand', 'gravel'];

export function installMovement(bot) {
  bot.loadPlugin(pathfinder);

  const mcData = bot.mcData;
  const m = new Movements(bot);

  m.canDig = true;
  m.allow1by1towers = true;
  m.allowParkour = true;
  m.allowSprinting = true;
  m.allowFreeMotion = false;
  // Never take fall damage on purpose.
  m.maxDropDown = 3;
  m.infiniteLiquidDropdownDistance = false;
  m.dontCreateFlow = true;
  m.dontMineUnderFallingBlock = true;

  m.scafoldingBlocks = SCAFFOLD.map((n) => mcData.itemsByName[n]?.id).filter((x) => x != null);

  for (const name of AVOID) {
    const b = mcData.blocksByName[name];
    if (b) {
      m.blocksToAvoid.add(b.id);
      m.blocksCantBreak.add(b.id);
    }
  }
  // Don't break anything valuable or structural while pathing.
  for (const name of ['chest', 'trapped_chest', 'ender_chest', 'furnace', 'crafting_table', 'bed', 'white_bed', 'red_bed', 'shulker_box', 'barrel', 'brewing_stand', 'enchanting_table', 'anvil', 'beacon', 'spawner', 'end_portal_frame']) {
    const b = mcData.blocksByName[name];
    if (b) m.blocksCantBreak.add(b.id);
  }

  bot.pathfinder.setMovements(m);
  bot.movements = m;

  // Safe variant for dangerous areas: no digging, no towers.
  const safe = new Movements(bot);
  safe.canDig = false;
  safe.allow1by1towers = false;
  safe.maxDropDown = 2;
  safe.allowParkour = false;
  for (const name of AVOID) {
    const b = mcData.blocksByName[name];
    if (b) safe.blocksToAvoid.add(b.id);
  }
  bot.safeMovements = safe;

  log.info('pathfinder loaded (lava-avoiding, fall-safe)');
}

const stop = (bot) => {
  try {
    bot.pathfinder.setGoal(null);
  } catch {}
  for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(c, false);
};

/** Core goto with abort support and a retry that widens the tolerance. */
export async function goTo(bot, task, x, y, z, { range = 1, timeoutMs = 90000, safeMode = false } = {}) {
  task.check();
  if (safeMode) bot.pathfinder.setMovements(bot.safeMovements);

  const goal = new GoalNear(x, y, z, range);
  const started = Date.now();

  const watchdog = setInterval(() => {
    if (task.aborted || Date.now() - started > timeoutMs) stop(bot);
  }, 200);

  try {
    await bot.pathfinder.goto(goal);
    task.check();
    return { ok: true };
  } catch (err) {
    if (task.aborted) throw new AbortError(task.reason);
    if (/Took too long|No path|Timeout|goal/i.test(err.message || '')) {
      // Try again, less fussy about exactly where she ends up.
      try {
        await bot.pathfinder.goto(new GoalNear(x, y, z, Math.max(range + 3, 4)));
        return { ok: true, loose: true };
      } catch (e2) {
        return { ok: false, reason: `cannot reach ${Math.round(x)},${Math.round(y)},${Math.round(z)}: ${e2.message}` };
      }
    }
    return { ok: false, reason: err.message };
  } finally {
    clearInterval(watchdog);
    if (safeMode) bot.pathfinder.setMovements(bot.movements);
  }
}

export async function gotoVec(bot, task, pos, opts) {
  return goTo(bot, task, pos.x, pos.y, pos.z, opts);
}

export function ownerEntity(bot) {
  return bot.players[config.owner]?.entity || null;
}

/** "trisha come here" */
export async function come(bot, task, { range = 2 } = {}) {
  const owner = ownerEntity(bot);
  if (!owner) return { ok: false, reason: `cannot see ${config.owner}` };
  const p = owner.position;
  const res = await goTo(bot, task, p.x, p.y, p.z, { range });
  if (res.ok) return { ok: true, detail: 'arrived' };
  return res;
}

/** Persistent follow — keeps re-goaling as the owner moves. */
export async function follow(bot, task, { player, distance = 3, durationMs = 0 } = {}) {
  const name = player || config.owner;
  const target = bot.players[name]?.entity;
  if (!target) return { ok: false, reason: `cannot see ${name}` };

  bot.pathfinder.setGoal(new GoalFollow(target, distance), true);
  log.act(`following ${name} at ${distance}m`);
  const started = Date.now();

  try {
    while (!task.aborted) {
      await task.sleep(500);
      const live = bot.players[name]?.entity;
      if (!live) {
        // They walked out of render or logged off — hold position and wait a bit.
        await task.sleep(2000);
        const back = bot.players[name]?.entity;
        if (!back) return { ok: false, reason: `lost ${name}` };
        bot.pathfinder.setGoal(new GoalFollow(back, distance), true);
      }
      if (durationMs && Date.now() - started > durationMs) return { ok: true, detail: 'follow finished' };
    }
    return { ok: true, detail: 'follow stopped' };
  } finally {
    stop(bot);
  }
}

/** Run away from a threat to a safer place. */
export async function flee(bot, task, { from, distance = 20 } = {}) {
  const me = bot.entity.position;
  let away;
  if (from?.position) {
    away = me.minus(from.position).normalize().scaled(distance);
  } else {
    const a = Math.random() * Math.PI * 2;
    away = new Vec3(Math.cos(a) * distance, 0, Math.sin(a) * distance);
  }
  const dest = me.plus(away);
  log.act(`fleeing to ${Math.round(dest.x)},${Math.round(dest.z)}`);
  try {
    await bot.pathfinder.goto(new GoalXZ(Math.round(dest.x), Math.round(dest.z)));
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Wander outward looking for something new. */
export async function explore(bot, task, { radius = 80 } = {}) {
  const start = bot.entity.position.clone();
  const a = Math.random() * Math.PI * 2;
  const dest = start.offset(Math.cos(a) * radius, 0, Math.sin(a) * radius);
  log.act(`exploring toward ${Math.round(dest.x)},${Math.round(dest.z)}`);
  try {
    await bot.pathfinder.goto(new GoalXZ(Math.round(dest.x), Math.round(dest.z)));
    return { ok: true, detail: `explored ${radius} blocks` };
  } catch (err) {
    if (task.aborted) throw new AbortError();
    return { ok: false, reason: err.message };
  }
}

/** Descend to a target Y with a safe staircase rather than a suicide shaft. */
export async function descendTo(bot, task, targetY, { safe = true } = {}) {
  const { digDown } = await import('./gather.js');
  return digDown(bot, task, { toY: targetY, staircase: safe });
}

export async function goHome(bot, task) {
  const base = mem.all.base;
  if (!base) return { ok: false, reason: 'no home marked yet' };
  log.act(`heading home to ${base.x},${base.y},${base.z}`);
  const res = await goTo(bot, task, base.x, base.y, base.z, { range: 3, timeoutMs: 240000 });
  return res.ok ? { ok: true, detail: 'home' } : res;
}

export async function gotoWaypoint(bot, task, { name }) {
  const wp = mem.all.waypoints[name];
  if (!wp) return { ok: false, reason: `no waypoint called ${name}` };
  return goTo(bot, task, wp.x, wp.y, wp.z, { range: 2 });
}

/** Look where the owner is looking — used when he says "that one". */
export function lookedAtByOwner(bot, maxDistance = 40) {
  const owner = ownerEntity(bot);
  if (!owner) return null;
  const eye = owner.position.offset(0, owner.height * 0.9 || 1.6, 0);
  const dir = directionOf(owner);
  let best = null;
  let bestDot = 0.94;
  for (const e of Object.values(bot.entities)) {
    if (!e?.position || e === bot.entity || e === owner) continue;
    const to = e.position.offset(0, (e.height || 1) / 2, 0).minus(eye);
    const d = to.norm();
    if (d > maxDistance) continue;
    const dot = to.normalize().dot(dir);
    if (dot > bestDot) {
      bestDot = dot;
      best = e;
    }
  }
  return best;
}

function directionOf(entity) {
  const yaw = entity.yaw ?? 0;
  const pitch = entity.pitch ?? 0;
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch)).normalize();
}

export { stop as stopMoving, goals };
