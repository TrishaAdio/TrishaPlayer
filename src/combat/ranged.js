/**
 * BALLISTICS — real arrow trajectory solving.
 *
 * The previous bow code guessed: it added a linear "drop" term proportional to
 * distance and led the target with a flat multiplier. That is wrong at both ends —
 * it undershoots badly past ~20 blocks and overshoots up close, because an arrow
 * follows a drag-damped parabola, not a line.
 *
 * Minecraft arrow physics, per tick:
 *     pos += vel
 *     vel *= 0.99          (air drag)
 *     vel.y -= 0.05        (gravity)
 * with |vel| = 3.0 blocks/tick at full draw.
 *
 * Rather than invent a closed form that ignores drag, this simulates the arrow
 * tick-for-tick and searches for the launch pitch that actually lands on the target.
 * Coarse sweep to bracket the solution, then a fine local refine. A few thousand
 * cheap float operations per shot, which is nothing at bow cadence.
 *
 * Target movement is handled by iteration: solve, read off the flight time, move the
 * target forward by that much, solve again. Three passes converge tightly.
 */
import { Vec3 } from 'vec3';

export const ARROW_SPEED = 3.0;   // blocks per tick at full draw
export const ARROW_GRAVITY = 0.05;
export const ARROW_DRAG = 0.99;
export const TICKS_PER_SECOND = 20;

/**
 * Fly an arrow and report where it is when it has covered `targetX` horizontally.
 * Returns null if it never gets there (fell short).
 */
export function simulateArrow(pitchRad, targetX, { speed = ARROW_SPEED, maxTicks = 240 } = {}) {
  let x = 0;
  let y = 0;
  let vx = Math.cos(pitchRad) * speed;
  let vy = Math.sin(pitchRad) * speed;

  for (let t = 0; t < maxTicks; t++) {
    const prevX = x;
    const prevY = y;
    x += vx;
    y += vy;
    vx *= ARROW_DRAG;
    vy *= ARROW_DRAG;
    vy -= ARROW_GRAVITY;

    if (x >= targetX) {
      // Interpolate to the exact horizontal distance for sub-tick accuracy.
      const span = x - prevX;
      const frac = span > 1e-9 ? (targetX - prevX) / span : 0;
      return { y: prevY + (y - prevY) * frac, ticks: t + frac };
    }
    // Once it is descending steeply and far below, it will never arrive.
    if (y < -256) break;
  }
  return null;
}

/**
 * Launch pitch (radians, positive = up) that lands an arrow at (targetX, targetY).
 * Prefers the flat trajectory over the lobbed one: it arrives sooner, so the target
 * has less time to move, and it is far less likely to clip terrain.
 */
export function solvePitch(targetX, targetY, { speed = ARROW_SPEED } = {}) {
  if (targetX < 0.1) targetX = 0.1;

  const coarseStep = (1 * Math.PI) / 180;
  const lo = (-70 * Math.PI) / 180;
  const hi = (70 * Math.PI) / 180;

  let best = null;
  for (let p = lo; p <= hi; p += coarseStep) {
    const hit = simulateArrow(p, targetX, { speed });
    if (!hit) continue;
    const err = Math.abs(hit.y - targetY);
    if (!best || err < best.err) best = { pitch: p, err, ticks: hit.ticks };
    // Flat arc found and good enough: stop before finding the lobbed twin.
    if (best.err < 0.02 && p > 0) break;
  }
  if (!best) return null;

  // Fine refine around the bracket.
  const fineStep = (0.02 * Math.PI) / 180;
  let refined = best;
  for (let p = best.pitch - coarseStep; p <= best.pitch + coarseStep; p += fineStep) {
    const hit = simulateArrow(p, targetX, { speed });
    if (!hit) continue;
    const err = Math.abs(hit.y - targetY);
    if (err < refined.err) refined = { pitch: p, err, ticks: hit.ticks };
  }
  return refined;
}

/** mineflayer's own yaw convention. */
export function yawTo(dx, dz) {
  return Math.atan2(-dx, -dz);
}

/**
 * Full firing solution against a moving entity.
 *
 * Iterates lead prediction against flight time so the arrow is aimed where the
 * target will be, using its actual velocity vector rather than a fudge factor.
 */
export function aimSolution(bot, target, { speed = ARROW_SPEED, passes = 3, leadFactor = 1.0 } = {}) {
  const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
  const targetHeight = target.height ?? 1.8;
  // Aim centre-mass, slightly below the eyes.
  const baseAim = target.position.offset(0, targetHeight * 0.55, 0);
  const vel = target.velocity || new Vec3(0, 0, 0);

  let predicted = baseAim.clone();
  let solution = null;

  for (let i = 0; i < passes; i++) {
    const dx = predicted.x - eye.x;
    const dy = predicted.y - eye.y;
    const dz = predicted.z - eye.z;
    const horizontal = Math.sqrt(dx * dx + dz * dz);

    const sol = solvePitch(horizontal, dy, { speed });
    if (!sol) return null;
    solution = { ...sol, yaw: yawTo(dx, dz), horizontal, flightTicks: sol.ticks };

    // Move the target forward by the flight time and try again.
    const lead = vel.scaled(sol.ticks * leadFactor);
    predicted = baseAim.plus(lead);
  }

  if (!solution) return null;
  return {
    yaw: solution.yaw,
    pitch: solution.pitch,
    flightTicks: solution.flightTicks,
    flightSeconds: solution.flightTicks / TICKS_PER_SECOND,
    error: solution.err,
    distance: solution.horizontal,
    predicted,
  };
}

/**
 * Is the shot actually available, or is there a wall in the way?
 * Shooting into terrain wastes arrows and, worse, wastes the tempo of the shot.
 */
export function hasClearShot(bot, target, solution) {
  try {
    const eye = bot.entity.position.offset(0, bot.entity.height ?? 1.62, 0);
    const to = (solution?.predicted || target.position.offset(0, 1, 0)).minus(eye);
    const dist = to.norm();
    if (dist < 1) return true;
    const dir = to.normalize();
    const block = bot.world.raycast ? bot.world.raycast(eye, dir, Math.min(dist, 64)) : null;
    if (!block) return true;
    // A hit further away than the target means the target is in front of it.
    const hitDist = block.position ? eye.distanceTo(block.position) : Infinity;
    return hitDist >= dist - 1.5;
  } catch {
    return true; // never refuse to shoot just because the check failed
  }
}

/**
 * How long the bow has been drawn, as a fraction of full charge.
 * Full power needs 1 second (20 ticks); below ~0.85 the arrow is weak and slow,
 * so she never releases early.
 */
export function drawFraction(ms) {
  return Math.min(1, ms / 1000);
}

export function speedForDraw(fraction) {
  // Minecraft scales arrow velocity with charge, capped at 3.0.
  const f = Math.max(0, Math.min(1, fraction));
  return 3.0 * f;
}

/** Diagnostics for the offline ballistics tests. */
export function predictLanding(pitchRad, distance, { speed = ARROW_SPEED } = {}) {
  return simulateArrow(pitchRad, distance, { speed });
}
