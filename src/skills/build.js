/**
 * Building. Emergency shelter, and a real base — walls, roof, door, windows,
 * lighting, storage, beds. Not a dirt box.
 */
import { Vec3 } from 'vec3';
import { log } from '../util/log.js';
import { mem } from '../world/memory.js';
import { config } from '../config.js';
import { AbortError } from '../task.js';
import { goTo } from './move.js';
import { craft } from './craft.js';
import { digBlock } from './gather.js';

const UP = new Vec3(0, 1, 0);
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
const ALL_FACES = [...SIDES, UP, new Vec3(0, -1, 0)];

const WALL_MATS = ['cobblestone', 'stone', 'oak_planks', 'spruce_planks', 'birch_planks', 'deepslate', 'cobbled_deepslate', 'andesite', 'granite', 'diorite', 'tuff', 'dirt'];
const ROOF_MATS = ['oak_planks', 'spruce_planks', 'birch_planks', 'cobblestone', 'stone', 'dirt'];
const GLASS = ['glass', 'glass_pane'];

const count = (bot, n) => bot.inventory.items().reduce((a, i) => (i.name === n ? a + i.count : a), 0);
const findAny = (bot, names) => {
  for (const n of names) {
    const it = bot.inventory.items().find((i) => i.name === n);
    if (it) return it;
  }
  return null;
};

/** Place a block at an exact position, walking closer if she cannot reach. */
export async function placeAt(bot, task, pos, itemNames, { replace = false } = {}) {
  task.check();
  const existing = bot.blockAt(pos);
  if (!existing) return false;
  if (existing.boundingBox === 'block') {
    if (!replace) return true;
    await digBlock(bot, task, existing);
  }

  const item = Array.isArray(itemNames) ? findAny(bot, itemNames) : bot.inventory.items().find((i) => i.name === itemNames);
  if (!item) return false;

  if (bot.entity.position.distanceTo(pos) > 4.0) {
    await goTo(bot, task, pos.x, pos.y + 1, pos.z, { range: 2, timeoutMs: 15000 }).catch(() => {});
  }

  // Any adjacent solid block can act as the reference face.
  for (const face of ALL_FACES) {
    const refPos = pos.plus(face);
    const ref = bot.blockAt(refPos);
    if (!ref || ref.boundingBox !== 'block') continue;
    try {
      if (bot.heldItem?.name !== item.name) await bot.equip(item, 'hand');
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(ref, face.scaled(-1));
      const now = bot.blockAt(pos);
      if (now && now.boundingBox === 'block') return true;
    } catch (err) {
      if (task.aborted) throw new AbortError();
    }
  }
  return false;
}

async function clearVolume(bot, task, min, max) {
  let dug = 0;
  for (let y = min.y; y <= max.y; y++) {
    for (let x = min.x; x <= max.x; x++) {
      for (let z = min.z; z <= max.z; z++) {
        task.check();
        const b = bot.blockAt(new Vec3(x, y, z));
        if (!b || b.boundingBox === 'empty') continue;
        if (/bedrock|chest|furnace|crafting_table|bed/.test(b.name)) continue;
        if (bot.entity.position.distanceTo(b.position) > 4.2) {
          await goTo(bot, task, x, y, z, { range: 3, timeoutMs: 10000 }).catch(() => {});
        }
        if (await digBlock(bot, task, b)) dug++;
      }
    }
  }
  return dug;
}

/**
 * Enough wall material, mined on the spot if she is short — but in batches.
 *
 * Asking for the whole structure up front produced "mining 144x stone", a request so
 * large that she disappeared into a mining loop for minutes and never laid a block.
 * Gathering is now capped per trip, and building proceeds with whatever she has:
 * a partially walled base is progress, an endless quarry is not.
 */
const GATHER_BATCH = 48;

async function ensureBlocks(bot, task, needed) {
  const have = () => WALL_MATS.reduce((n, m) => n + count(bot, m), 0);
  if (have() >= needed) return true;

  const want = Math.min(needed - have(), GATHER_BATCH);
  log.act(`need ${needed - have()} building blocks, gathering ${want} now`);
  const { mine } = await import('./gather.js');
  const res = await mine(bot, task, { block: 'stone', count: want }).catch((e) => {
    if (e?.aborted) throw e;
    return { ok: false };
  });
  if (!res.ok && res.reason) log.warn(`block gathering fell short: ${res.reason}`);

  // Enough to be useful is enough to start.
  return have() >= Math.min(needed, 16);
}

/** Blocks a bare fist can actually break and collect. */
const HAND_BREAKABLE = /^(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|sand|red_sand|gravel|clay|mud|snow_block|moss_block|soul_sand)$/;

/**
 * BARE-HANDS PANIC HOLE.
 *
 * The shelter she actually needs is the one she needs straight after dying: no pickaxe,
 * no blocks, a zombie already hitting her. `ensureBlocks` tried to MINE STONE, which
 * drops nothing without a pickaxe, so shelter returned "walled in with 1 blocks" in
 * 0.0 seconds and she stood there being eaten to death.
 *
 * Dirt and gravel break by hand. Two blocks down, pull the lid over, wait it out.
 */
async function panicHole(bot, task) {
  const startY = bot.entity.position.y;

  for (let i = 0; i < 2; i++) {
    task.check();
    const feet = bot.entity.position.floored();
    const under = bot.blockAt(feet.offset(0, -1, 0));
    if (!under || !HAND_BREAKABLE.test(under.name)) break;
    if (!(await digBlock(bot, task, under))) break;
    await task.sleep(450); // let her drop into it
  }

  const now = bot.entity.position.floored();
  if (bot.entity.position.y >= startY - 0.5) return false; // never got down

  // The lid goes two above her feet, leaving her a head-height pocket. The dirt she
  // just dug is usually what seals it.
  const lid = ['dirt', 'coarse_dirt', 'grass_block', 'gravel', 'sand', ...WALL_MATS];
  if (await placeAt(bot, task, now.offset(0, 2, 0), lid)) {
    mem.set('shelterBuilt', true);
    mem.addWaypoint('shelter', now);
    log.act(`dug in bare-handed at ${now.x},${now.y},${now.z} and pulled the lid over`);
    return true;
  }
  return false;
}

/**
 * Emergency shelter. Fast, cheap, mob-proof. Preference is to burrow into
 * terrain and seal the hole — cheaper and safer than a freestanding box.
 */
export async function shelter(bot, task, {} = {}) {
  log.act('building shelter');

  /**
   * No tools and nothing to build with: go straight underground. Trying to gather
   * stone first is what wasted the only seconds she had.
   */
  const onHand = () => WALL_MATS.reduce((n, m) => n + count(bot, m), 0);
  const hasPick = bot.inventory.items().some((i) => /_pickaxe$/.test(i.name));
  if (onHand() < 4 && !hasPick) {
    if (await panicHole(bot, task)) return { ok: true, detail: 'dug in bare-handed' };
  }

  await ensureBlocks(bot, task, 14);

  const p = bot.entity.position.floored();

  // Try to burrow sideways into a hill.
  for (const dir of SIDES) {
    task.check();
    const wall = bot.blockAt(p.plus(dir));
    const wallUp = bot.blockAt(p.plus(dir).offset(0, 1, 0));
    if (wall?.boundingBox === 'block' && wallUp?.boundingBox === 'block') {
      const inner = p.plus(dir.scaled(2));
      await digBlock(bot, task, bot.blockAt(p.plus(dir)));
      await digBlock(bot, task, bot.blockAt(p.plus(dir).offset(0, 1, 0)));
      await digBlock(bot, task, bot.blockAt(inner));
      await digBlock(bot, task, bot.blockAt(inner.offset(0, 1, 0)));
      await goTo(bot, task, inner.x, inner.y, inner.z, { range: 0, timeoutMs: 10000 }).catch(() => {});
      // Seal behind her.
      await placeAt(bot, task, p.plus(dir), WALL_MATS);
      await placeAt(bot, task, p.plus(dir).offset(0, 1, 0), WALL_MATS);
      const torch = bot.inventory.items().find((i) => i.name === 'torch');
      if (torch) await placeAt(bot, task, inner.offset(0, 0, 0), 'torch').catch(() => {});
      mem.set('shelterBuilt', true);
      mem.addWaypoint('shelter', inner);
      log.act('burrowed in and sealed up');
      return { ok: true, detail: 'sheltered in the hillside' };
    }
  }

  // No hill: box herself in where she stands.
  let placed = 0;
  for (const dy of [0, 1]) {
    for (const dir of SIDES) {
      if (await placeAt(bot, task, p.plus(dir).offset(0, dy, 0), WALL_MATS)) placed++;
    }
  }
  if (await placeAt(bot, task, p.offset(0, 2, 0), WALL_MATS)) placed++;
  const floor = bot.blockAt(p.offset(0, -1, 0));
  if (!floor || floor.boundingBox !== 'block') await placeAt(bot, task, p.offset(0, -1, 0), WALL_MATS);

  if (placed > 4) {
    mem.set('shelterBuilt', true);
    return { ok: true, detail: `walled in with ${placed} blocks` };
  }

  // Boxing in failed — get under the ground instead of standing in the open.
  if (await panicHole(bot, task)) return { ok: true, detail: 'dug in bare-handed' };
  return { ok: false, detail: `walled in with ${placed} blocks`, reason: 'nothing to build with and no soft ground to dig' };
}

/**
 * "make a base for us"
 *
 * A proper house: cleared plot, floor, walls, roof, a real door, windows if she has
 * glass, torch-lit inside so nothing spawns, plus crafting table, furnace, chest and
 * beds. Registered as home so she knows where to come back to.
 */
export async function buildBase(bot, task, { size = 7, near = 'here' } = {}) {
  const inner = Math.max(5, Math.min(13, size));
  const half = Math.floor(inner / 2);
  const height = 4;

  let origin = bot.entity.position.floored();
  if (near === 'owner') {
    const owner = bot.players[config.owner]?.entity;
    if (owner) origin = owner.position.floored().offset(3, 0, 3);
  }

  log.act(`building a ${inner}x${inner} base at ${origin.x},${origin.y},${origin.z}`);
  const needed = inner * inner + inner * 4 * height;
  // One batch before starting; the walls top themselves up as they go.
  const gathered = await ensureBlocks(bot, task, Math.min(needed, GATHER_BATCH));
  if (!gathered) {
    return { ok: false, reason: 'not enough building blocks and none to mine nearby' };
  }

  const min = origin.offset(-half, 0, -half);
  const max = origin.offset(half, height, half);

  // 1. Clear the plot.
  await clearVolume(bot, task, min, max);

  // 2. Floor.
  let floorLaid = 0;
  for (let x = min.x; x <= max.x; x++) {
    for (let z = min.z; z <= max.z; z++) {
      task.check();
      const pos = new Vec3(x, origin.y - 1, z);
      const b = bot.blockAt(pos);
      if (b && b.boundingBox === 'block') continue;
      if (await placeAt(bot, task, pos, WALL_MATS)) floorLaid++;
    }
  }

  // 3. Walls, leaving a 1x2 doorway in the middle of the south face.
  const doorX = origin.x;
  const doorZ = max.z;
  let wallBlocks = 0;
  for (let y = origin.y; y < origin.y + height - 1; y++) {
    for (let x = min.x; x <= max.x; x++) {
      for (let z = min.z; z <= max.z; z++) {
        task.check();
        const isEdge = x === min.x || x === max.x || z === min.z || z === max.z;
        if (!isEdge) continue;
        // doorway
        if (x === doorX && z === doorZ && y < origin.y + 2) continue;
        // windows at eye level
        const isWindowRow = y === origin.y + 1;
        const isWindowSpot = isWindowRow && ((x - min.x) % 3 === 0 || (z - min.z) % 3 === 0);
        const pos = new Vec3(x, y, z);
        if (isWindowSpot && findAny(bot, GLASS)) {
          if (await placeAt(bot, task, pos, GLASS)) {
            wallBlocks++;
            continue;
          }
        }
        if (await placeAt(bot, task, pos, WALL_MATS)) wallBlocks++;
      }
    }
  }

  // 4. Roof.
  let roof = 0;
  for (let x = min.x; x <= max.x; x++) {
    for (let z = min.z; z <= max.z; z++) {
      task.check();
      if (await placeAt(bot, task, new Vec3(x, origin.y + height - 1, z), ROOF_MATS)) roof++;
    }
  }

  // 5. A real door.
  const doorItem = bot.inventory.items().find((i) => /_door$/.test(i.name));
  if (!doorItem) await craft(bot, task, { item: 'oak_door', count: 1, optional: true }).catch(() => {});
  const door = bot.inventory.items().find((i) => /_door$/.test(i.name));
  if (door) {
    await placeAt(bot, task, new Vec3(doorX, origin.y, doorZ), door.name).catch(() => {});
  }

  // 6. Light it so nothing spawns inside.
  await lightArea(bot, task, { radius: half + 1, spacing: 4 }).catch(() => {});

  // 7. Furnish: crafting table, furnace, chest, bed.
  const corner = new Vec3(min.x + 1, origin.y, min.z + 1);
  const furnish = [
    { names: ['crafting_table'], pos: corner },
    { names: ['furnace'], pos: corner.offset(1, 0, 0) },
    { names: ['chest'], pos: corner.offset(2, 0, 0) },
  ];
  for (const f of furnish) {
    task.check();
    if (!findAny(bot, f.names)) await craft(bot, task, { item: f.names[0], count: 1, optional: true }).catch(() => {});
    if (findAny(bot, f.names)) {
      const ok = await placeAt(bot, task, f.pos, f.names);
      if (ok && f.names[0] === 'chest') mem.addChest(f.pos, 'base chest');
    }
  }

  const bed = bot.inventory.items().find((i) => /_bed$/.test(i.name));
  if (bed) {
    const bedPos = new Vec3(max.x - 1, origin.y, min.z + 1);
    if (await placeAt(bot, task, bedPos, bed.name)) mem.setBed(bedPos);
  }

  mem.setBase(origin, 'base');
  mem.set('shelterBuilt', true);
  mem.note(`built a ${inner}x${inner} base at ${origin.x},${origin.y},${origin.z}`);

  return {
    ok: wallBlocks > 8,
    detail: `base done: ${inner}x${inner}, ${floorLaid} floor, ${wallBlocks} wall, ${roof} roof blocks`,
  };
}

/** Torch grid so mobs cannot spawn in the area. */
export async function lightArea(bot, task, { radius = 8, spacing = 5 } = {}) {
  let torches = count(bot, 'torch');
  if (torches < 4) {
    await craft(bot, task, { item: 'torch', count: 16, optional: true }).catch(() => {});
    torches = count(bot, 'torch');
  }
  if (!torches) return { ok: false, reason: 'no torches and nothing to make them from' };

  const origin = bot.entity.position.floored();
  let placed = 0;
  for (let dx = -radius; dx <= radius; dx += spacing) {
    for (let dz = -radius; dz <= radius; dz += spacing) {
      task.check();
      if (placed >= torches) break;
      const ground = findGroundNear(bot, origin.offset(dx, 0, dz));
      if (!ground) continue;
      if (await placeAt(bot, task, ground.offset(0, 1, 0), 'torch')) placed++;
    }
  }
  return { ok: placed > 0, detail: `placed ${placed} torches` };
}

function findGroundNear(bot, pos) {
  for (let dy = 2; dy >= -4; dy--) {
    const p = pos.offset(0, dy, 0);
    const b = bot.blockAt(p);
    const above = bot.blockAt(p.offset(0, 1, 0));
    if (b?.boundingBox === 'block' && above?.boundingBox === 'empty') return p;
  }
  return null;
}

/** Bridge across a gap toward a point. */
export async function bridgeTo(bot, task, { x, y, z }) {
  const dest = new Vec3(x, y, z);

  /**
   * Check the materials BEFORE stepping out over a gap.
   *
   * She was starting bridges with almost nothing in her pack, running dry partway and
   * ending up stranded on a one-block ledge over open air. Refusing to start is the
   * correct behaviour when there is no way to finish.
   */
  const stock = () => WALL_MATS.reduce((n, m) => n + count(bot, m), 0);
  const span = Math.ceil(bot.entity.position.distanceTo(dest));
  if (stock() < Math.min(span, 12)) {
    await ensureBlocks(bot, task, Math.min(span + 8, GATHER_BATCH)).catch(() => {});
  }
  if (stock() < 4) {
    return { ok: false, reason: `not enough blocks to bridge ${span} blocks (have ${stock()})` };
  }

  log.act(`bridging to ${x},${y},${z} with ${stock()} blocks for a ${span} block span`);
  let placed = 0;
  let guard = 0;

  while (bot.entity.position.distanceTo(dest) > 2 && guard++ < 200) {
    task.check();
    const p = bot.entity.position.floored();
    const dir = dest.minus(bot.entity.position);
    const step = Math.abs(dir.x) > Math.abs(dir.z)
      ? new Vec3(Math.sign(dir.x), 0, 0)
      : new Vec3(0, 0, Math.sign(dir.z));

    const next = p.plus(step);
    const under = bot.blockAt(next.offset(0, -1, 0));
    if (!under || under.boundingBox !== 'block') {
      if (!(await placeAt(bot, task, next.offset(0, -1, 0), WALL_MATS))) {
        if (!(await ensureBlocks(bot, task, 16))) return { ok: placed > 0, reason: 'out of blocks' };
        continue;
      }
      placed++;
    }
    const res = await goTo(bot, task, next.x, next.y, next.z, { range: 0, timeoutMs: 8000 });
    if (!res.ok) {
      bot.setControlState('forward', true);
      await task.sleep(250);
      bot.setControlState('forward', false);
    }
  }
  return { ok: true, detail: `bridged with ${placed} blocks` };
}

/** Tower straight up — escape, or a lookout. */
export async function pillarUp(bot, task, { height = 8 } = {}) {
  await ensureBlocks(bot, task, height + 2);
  const startY = bot.entity.position.y;
  let built = 0;
  while (built < height) {
    task.check();
    const p = bot.entity.position.floored();
    const item = findAny(bot, WALL_MATS);
    if (!item) break;
    try {
      await bot.equip(item, 'hand');
      bot.setControlState('jump', true);
      await task.sleep(180);
      const below = bot.blockAt(p);
      if (below) {
        await bot.placeBlock(bot.blockAt(p.offset(0, -1, 0)) || below, UP).catch(() => {});
      }
      bot.setControlState('jump', false);
      built = Math.floor(bot.entity.position.y - startY);
    } catch {
      bot.setControlState('jump', false);
      break;
    }
  }
  return { ok: built > 0, detail: `towered up ${built} blocks` };
}

export async function placeBlockAt(bot, task, { block, x, y, z }) {
  const ok = await placeAt(bot, task, new Vec3(x, y, z), block, { replace: true });
  return ok ? { ok: true, detail: `placed ${block}` } : { ok: false, reason: `could not place ${block}` };
}

export async function markHome(bot, task) {
  mem.setBase(bot.entity.position, 'home');
  return { ok: true, detail: `home marked at ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)}` };
}
