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
  m.allowSprinting = true;
  m.allowFreeMotion = false;

  /**
   * Parkour, deliberately generous.
   *
   * RAREAURA singled this out as the thing she does best, and it is also genuinely
   * faster than digging or bridging: a bot that can jump a 3-block gap takes direct
   * routes a walking bot cannot. Sprint-jumping is enabled alongside it so the jumps
   * have the momentum to actually land.
   */
  m.allowParkour = true;
  m.allowSprinting = true;
  if ('maxParkourJump' in m) m.maxParkourJump = 4;
  if ('parkourCost' in m) m.parkourCost = 1; // stop treating jumps as expensive

  // Never take fall damage on purpose. Parkour is fine; falling is not.
  m.maxDropDown = 3;
  m.infiniteLiquidDropdownDistance = false;
  m.dontCreateFlow = true;
  m.dontMineUnderFallingBlock = true;

  m.scafoldingBlocks = SCAFFOLD.map((n) => mcData.itemsByName[n]?.id).filter((x) => x != null);

  /**
   * WATER IS EXPENSIVE.
   *
   * She drowned in the sea repeatedly over a two hour session. The pathfinder was
   * treating water as ordinary terrain, so a route straight across a bay looked
   * cheaper than walking around it — and swimming a long crossing means running out
   * of air in the middle. Making liquid enormously expensive keeps her on land
   * whenever land exists, without forbidding a one-block stream crossing outright.
   */
  if ('liquidCost' in m) m.liquidCost = 40;
  m.allowEntityDetection = true;

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
        /**
         * Re-check for cancellation before reporting a plain failure. Without this the
         * second attempt swallowed the abort and returned "cannot reach ...: the goal
         * was changed", which upstream treated as a real navigation failure and
         * retried — re-queueing a command the owner had already replaced.
         */
        if (task.aborted) throw new AbortError(task.reason);
        return { ok: false, reason: `cannot reach ${Math.round(x)},${Math.round(y)},${Math.round(z)}: ${e2.message}` };
      }
    }
    if (task.aborted) throw new AbortError(task.reason);
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

/**
 * "trisha come here"
 *
 * Two attempts, because an exact 3D goal fails in exactly the situation where he most
 * often calls her: standing on a cliff, a roof or a tower while she is in water 15
 * blocks below. Observed live as "cannot reach -19,78,-33" over and over while she
 * treaded water. The fallback aims at his horizontal position and lets her climb,
 * which is good enough — being 3 blocks under him is arriving.
 */
export async function come(bot, task, { range = 2 } = {}) {
  let owner = ownerEntity(bot);

  /**
   * He is often out of entity range when he calls her — entities only load within a
   * few chunks, so from across the base she answered "cant see you" and did nothing.
   * If he is online, walk to where he was last seen and look again on arrival; by
   * then he is usually loaded and the normal approach takes over.
   */
  if (!owner) {
    const online = !!bot.players[config.owner];
    const last = mem.all.ownerLastSeen;
    if (!online) return { ok: false, reason: `${config.owner} is not online` };
    if (!last) return { ok: false, reason: `cannot see ${config.owner} and have never seen him` };

    log.act(`${config.owner} is out of range — heading to where he was last seen`);
    const approach = await goTo(bot, task, last.x, last.y, last.z, { range: 4, timeoutMs: 120000 });
    task.check();
    owner = ownerEntity(bot);
    if (!owner) {
      return approach.ok
        ? { ok: false, reason: `got to where you were but cannot find you` }
        : { ok: false, reason: `cannot reach where you were last seen` };
    }
  }

  const res = await goTo(bot, task, owner.position.x, owner.position.y, owner.position.z, { range });
  if (res.ok) return { ok: true, detail: 'arrived' };
  task.check();

  const live = ownerEntity(bot) || owner;
  log.act('direct path failed — approaching his column instead');
  try {
    await bot.pathfinder.goto(new GoalXZ(Math.round(live.position.x), Math.round(live.position.z)));
  } catch (err) {
    if (task.aborted) throw new AbortError(task.reason);
  }

  const now = ownerEntity(bot);
  const dist = now ? bot.entity.position.distanceTo(now.position) : Infinity;
  if (dist <= 12) return { ok: true, detail: `got within ${dist.toFixed(1)}m` };
  return { ok: false, reason: `could not get to you (${Number.isFinite(dist) ? `${dist.toFixed(0)}m away` : 'lost sight of you'})` };
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

/**
 * Wander outward looking for something new — but never toward open water.
 *
 * The old version picked a purely random bearing. On a coastal spawn that is a coin
 * flip on walking into the sea, which is precisely how she kept drowning. It now
 * samples several candidate directions and rejects any that head into a large body of
 * water, preferring the one with the most solid ground along the way.
 */
export async function explore(bot, task, { radius = 80 } = {}) {
  const start = bot.entity.position.clone();
  const waterId = bot.mcData.blocksByName.water?.id;

  const scoreBearing = (angle) => {
    let land = 0;
    let water = 0;
    for (let step = 8; step <= Math.min(radius, 64); step += 8) {
      const p = start.offset(Math.cos(angle) * step, 0, Math.sin(angle) * step).floored();
      // Look down a little for the surface at that column.
      let found = null;
      for (let dy = 6; dy >= -10; dy--) {
        const b = bot.blockAt(p.offset(0, dy, 0));
        if (b && b.boundingBox === 'block') {
          found = b;
          break;
        }
        if (b && waterId != null && b.type === waterId) {
          water++;
          found = b;
          break;
        }
      }
      if (found && /water/.test(found.name)) water++;
      else if (found) land++;
    }
    return { land, water, score: land - water * 3 };
  };

  let best = null;
  for (let i = 0; i < 8; i++) {
    const angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.3;
    const s = scoreBearing(angle);
    if (!best || s.score > best.score) best = { angle, ...s };
  }
  if (!best) best = { angle: Math.random() * Math.PI * 2, water: 0 };

  if (best.water > 2 && best.land === 0) {
    return { ok: false, reason: 'every direction from here is water — not swimming' };
  }

  const dest = start.offset(Math.cos(best.angle) * radius, 0, Math.sin(best.angle) * radius);
  log.act(`exploring toward ${Math.round(dest.x)},${Math.round(dest.z)} (land ${best.land}, water ${best.water})`);
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
