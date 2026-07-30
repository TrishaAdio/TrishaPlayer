/**
 * AREA SURVEY — look before deciding.
 *
 * The flaw this fixes, in RAREAURA's words: "like someone who doesn't have any
 * purpose ... tries to get wood, can't get, goes into sea and dies."
 *
 * She was choosing goals with no knowledge of her surroundings. "Chop wood" was
 * issued without knowing whether a single tree existed within reach, so when the
 * nearest forest was across an ocean she walked into the ocean.
 *
 * This module reads what is actually there — trees, water, animals, stone, caves,
 * hazards, buildable ground — and produces both a machine-readable snapshot and a
 * compact briefing for the planner. Every objective afterwards is grounded in real
 * coordinates instead of hope.
 */
import { Vec3 } from 'vec3';
import { log } from '../util/log.js';
import { FOOD_ANIMALS, HOSTILES } from './scan.js';

const LOG_TYPES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log'];
const ORES = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'redstone_ore', 'lapis_ore', 'diamond_ore', 'emerald_ore',
  'deepslate_coal_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore', 'deepslate_redstone_ore', 'deepslate_lapis_ore', 'deepslate_diamond_ore', 'deepslate_emerald_ore'];
const STONES = ['stone', 'deepslate', 'andesite', 'granite', 'diorite', 'tuff'];
const SOFT = ['dirt', 'grass_block', 'sand', 'gravel', 'clay'];
const HAZARDS = ['lava', 'fire', 'magma_block', 'powder_snow', 'cactus', 'sweet_berry_bush'];
const STRUCTURE_HINTS = ['polished_blackstone_bricks', 'gilded_blackstone', 'cobblestone_wall', 'bell', 'hay_block', 'chest', 'spawner', 'mossy_cobblestone', 'end_portal_frame', 'obsidian'];

const idsOf = (bot, names) => names.map((n) => bot.mcData.blocksByName[n]?.id).filter((x) => x != null);
const r = (n) => Math.round(n);

/** Group scattered positions into clusters so "a forest" reads as one thing. */
function clusterPositions(positions, spacing = 12) {
  const clusters = [];
  for (const p of positions) {
    let placed = false;
    for (const c of clusters) {
      if (Math.abs(c.x - p.x) <= spacing && Math.abs(c.z - p.z) <= spacing) {
        c.count++;
        c.x = Math.round((c.x * (c.count - 1) + p.x) / c.count);
        c.y = Math.round((c.y * (c.count - 1) + p.y) / c.count);
        c.z = Math.round((c.z * (c.count - 1) + p.z) / c.count);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ x: p.x, y: p.y, z: p.z, count: 1 });
  }
  return clusters.sort((a, b) => b.count - a.count);
}

/**
 * Is there open water big enough to drown in, and which way is it?
 * She needs this to know which direction NOT to walk.
 */
function waterAssessment(bot, radius) {
  const waterId = bot.mcData.blocksByName.water?.id;
  if (waterId == null) return { blocks: 0, nearest: null, ocean: false, bearing: null };
  const found = bot.findBlocks({ matching: [waterId], maxDistance: radius, count: 600 });
  if (!found.length) return { blocks: 0, nearest: null, ocean: false, bearing: null };

  const me = bot.entity.position;
  let nearest = found[0];
  let bestD = me.distanceTo(found[0]);
  let sumX = 0;
  let sumZ = 0;
  for (const p of found) {
    const d = me.distanceTo(p);
    if (d < bestD) {
      bestD = d;
      nearest = p;
    }
    sumX += p.x - me.x;
    sumZ += p.z - me.z;
  }
  const n = found.length;
  return {
    blocks: n,
    nearest: { x: r(nearest.x), y: r(nearest.y), z: r(nearest.z), distance: +bestD.toFixed(1) },
    // A lot of water spread over a wide area is an ocean or a large lake.
    ocean: n > 260,
    bearing: { x: +(sumX / n).toFixed(1), z: +(sumZ / n).toFixed(1) },
  };
}

/** A flat, dry, open patch big enough to build on. */
function findBuildSpot(bot, size = 7) {
  const me = bot.entity.position.floored();
  const half = Math.floor(size / 2);
  for (let ring = 0; ring <= 40; ring += 8) {
    for (const [dx, dz] of [[ring, 0], [-ring, 0], [0, ring], [0, -ring], [ring, ring], [-ring, -ring], [ring, -ring], [-ring, ring]]) {
      const centre = me.offset(dx, 0, dz);
      let ok = true;
      let baseY = null;
      for (let x = -half; x <= half && ok; x += 2) {
        for (let z = -half; z <= half && ok; z += 2) {
          const col = centre.offset(x, 0, z);
          let groundY = null;
          for (let dy = 4; dy >= -6; dy--) {
            const b = bot.blockAt(col.offset(0, dy, 0));
            const above = bot.blockAt(col.offset(0, dy + 1, 0));
            if (b && b.boundingBox === 'block' && above && above.boundingBox === 'empty') {
              if (/water|lava/.test(b.name)) ok = false;
              groundY = col.y + dy;
              break;
            }
          }
          if (groundY == null) ok = false;
          else if (baseY == null) baseY = groundY;
          else if (Math.abs(groundY - baseY) > 2) ok = false; // too uneven
        }
      }
      if (ok && baseY != null) {
        return { x: centre.x, y: baseY + 1, z: centre.z, flatness: 'good' };
      }
    }
  }
  return null;
}

/**
 * Full survey. Radius is in blocks; only loaded chunks can be read, so anything past
 * the server's view distance is invisible no matter how large a number is passed.
 */
export function surveyArea(bot, { radius = 96 } = {}) {
  const me = bot.entity.position;
  const t0 = Date.now();

  const trees = clusterPositions(bot.findBlocks({ matching: idsOf(bot, LOG_TYPES), maxDistance: radius, count: 400 }));
  const oreHits = bot.findBlocks({ matching: idsOf(bot, ORES), maxDistance: radius, count: 200 });
  const oreCounts = {};
  for (const p of oreHits) {
    const b = bot.blockAt(p);
    if (b) oreCounts[b.name] = (oreCounts[b.name] || 0) + 1;
  }

  const stoneCount = bot.findBlocks({ matching: idsOf(bot, STONES), maxDistance: 32, count: 200 }).length;
  const softCount = bot.findBlocks({ matching: idsOf(bot, SOFT), maxDistance: 32, count: 200 }).length;
  const hazards = clusterPositions(bot.findBlocks({ matching: idsOf(bot, HAZARDS), maxDistance: radius, count: 120 }), 16);
  const structures = {};
  for (const name of STRUCTURE_HINTS) {
    const id = bot.mcData.blocksByName[name]?.id;
    if (id == null) continue;
    const hits = bot.findBlocks({ matching: [id], maxDistance: radius, count: 12 });
    if (hits.length >= 3) {
      const c = clusterPositions(hits, 20)[0];
      structures[name] = { count: hits.length, x: c.x, y: c.y, z: c.z };
    }
  }

  const water = waterAssessment(bot, radius);

  const animals = [];
  const hostiles = [];
  for (const e of Object.values(bot.entities)) {
    if (!e?.position || e === bot.entity) continue;
    const d = me.distanceTo(e.position);
    if (d > radius) continue;
    if (FOOD_ANIMALS.has(e.name)) animals.push({ name: e.name, distance: +d.toFixed(1), x: r(e.position.x), y: r(e.position.y), z: r(e.position.z) });
    else if (HOSTILES.has(e.name)) hostiles.push({ name: e.name, distance: +d.toFixed(1) });
  }
  animals.sort((a, b) => a.distance - b.distance);

  // Terrain relief, to know whether she is on a mountain or a plain.
  let minY = 320;
  let maxY = -64;
  for (let dx = -24; dx <= 24; dx += 8) {
    for (let dz = -24; dz <= 24; dz += 8) {
      for (let dy = 24; dy >= -24; dy--) {
        const b = bot.blockAt(me.offset(dx, dy, dz));
        if (b && b.boundingBox === 'block' && !/water|lava/.test(b.name)) {
          const y = r(me.y) + dy;
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          break;
        }
      }
    }
  }

  const buildSpot = findBuildSpot(bot, 7);
  const biome = bot.blockAt(me.floored())?.biome?.name || 'unknown';

  const survey = {
    at: { x: r(me.x), y: r(me.y), z: r(me.z) },
    dimension: bot.game?.dimension?.replace('minecraft:', '') || 'overworld',
    biome,
    radius,
    timeOfDay: bot.time?.timeOfDay ?? 0,
    relief: { minY: minY === 320 ? null : minY, maxY: maxY === -64 ? null : maxY, spread: maxY - minY },
    trees: trees.slice(0, 4).map((c) => ({ logs: c.count, x: c.x, y: c.y, z: c.z, distance: +me.distanceTo(new Vec3(c.x, c.y, c.z)).toFixed(1) })),
    treeTotal: trees.reduce((n, c) => n + c.count, 0),
    water,
    stoneNearby: stoneCount,
    softGroundNearby: softCount,
    ores: oreCounts,
    animals: animals.slice(0, 6),
    animalTotal: animals.length,
    hostiles: hostiles.slice(0, 6),
    hazards: hazards.slice(0, 3).map((h) => ({ x: h.x, y: h.y, z: h.z, count: h.count })),
    structures,
    buildSpot,
    tookMs: Date.now() - t0,
  };

  log.info(`survey: ${survey.treeTotal} logs in ${survey.trees.length} groves, ${survey.animalTotal} animals, ${Object.keys(oreCounts).length} ore types, water ${water.blocks} blocks${water.ocean ? ' (OCEAN)' : ''}, ${survey.tookMs}ms`);
  return survey;
}

/** Compact briefing for the planner. Reads like a scout report, not JSON. */
export function surveyBriefing(survey) {
  const L = [];
  L.push(`Position ${survey.at.x},${survey.at.y},${survey.at.z} in ${survey.dimension}, biome ${survey.biome}.`);
  L.push(`Terrain: ground between Y${survey.relief.minY} and Y${survey.relief.maxY} (${survey.relief.spread > 16 ? 'steep/mountainous' : 'fairly flat'}).`);

  if (survey.trees.length) {
    L.push(`WOOD: ${survey.treeTotal} logs visible. Nearest grove ${survey.trees[0].logs} logs at ${survey.trees[0].x},${survey.trees[0].y},${survey.trees[0].z} (${survey.trees[0].distance}m).`);
  } else {
    L.push('WOOD: NO TREES VISIBLE ANYWHERE IN RANGE. Do not plan on chopping wood here.');
  }

  if (survey.animalTotal) {
    const a = survey.animals[0];
    L.push(`FOOD: ${survey.animalTotal} animals nearby, closest ${a.name} at ${a.x},${a.y},${a.z} (${a.distance}m).`);
  } else {
    L.push('FOOD: no animals in range. Fishing or crops may be the only options.');
  }

  L.push(`STONE: ${survey.stoneNearby > 40 ? 'plenty exposed within 32m' : survey.stoneNearby > 0 ? 'some exposed nearby' : 'none exposed — must dig down'}.`);

  const ores = Object.entries(survey.ores);
  L.push(ores.length ? `EXPOSED ORE: ${ores.map(([k, v]) => `${k} x${v}`).join(', ')}.` : 'EXPOSED ORE: none visible.');

  if (survey.water.blocks) {
    const w = survey.water;
    L.push(
      `WATER: ${w.blocks} blocks${w.ocean ? ' — this is a LARGE BODY / OCEAN' : ''}, nearest ${w.nearest.distance}m away at ${w.nearest.x},${w.nearest.y},${w.nearest.z}. ` +
      `It lies toward x${w.bearing.x > 0 ? '+' : ''}${w.bearing.x} z${w.bearing.z > 0 ? '+' : ''}${w.bearing.z}. DO NOT plan routes across it; she drowns.`,
    );
  } else {
    L.push('WATER: none in range.');
  }

  if (survey.hostiles.length) L.push(`THREATS: ${survey.hostiles.map((h) => `${h.name}@${h.distance}m`).join(', ')}.`);
  if (survey.hazards.length) L.push(`HAZARDS: lava or similar at ${survey.hazards.map((h) => `${h.x},${h.y},${h.z}`).join(' | ')}.`);
  const st = Object.entries(survey.structures);
  if (st.length) L.push(`STRUCTURES: ${st.map(([k, v]) => `${k} x${v.count} near ${v.x},${v.y},${v.z}`).join('; ')}.`);
  L.push(survey.buildSpot ? `BUILD SPOT: flat ground at ${survey.buildSpot.x},${survey.buildSpot.y},${survey.buildSpot.z}.` : 'BUILD SPOT: nothing flat found; would need levelling.');
  return L.join('\n');
}
