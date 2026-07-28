/**
 * Food. Hunting, cooking, crop farming, fishing — so she never starves and can
 * feed RAREAURA on request.
 */
import { Vec3 } from 'vec3';
import { log } from '../util/log.js';
import { AbortError } from '../task.js';
import { goTo } from './move.js';
import { collectDrops, digBlock } from './gather.js';
import { craft, smelt } from './craft.js';
import { equipWeapon } from '../reflex/gear.js';
import { FOOD_ANIMALS } from '../world/scan.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const COOKED = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato'];
const RAW = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato'];
const FORAGEABLE = ['sweet_berry_bush', 'wheat', 'carrots', 'potatoes', 'beetroots', 'melon', 'pumpkin'];

const count = (bot, n) => bot.inventory.items().reduce((a, i) => (i.name === n ? a + i.count : a), 0);
const total = (bot, names) => names.reduce((a, n) => a + count(bot, n), 0);

/** Kill an animal cleanly: close in, swing until it drops, take the meat. */
export async function butcher(bot, task, { animal = 'any', count: want = 2 } = {}) {
  await equipWeapon(bot).catch(() => {});
  let killed = 0;
  let misses = 0;

  while (killed < want && misses < 4) {
    task.check();
    const targets = Object.values(bot.entities)
      .filter((e) => e?.position && e.name && (animal === 'any' ? FOOD_ANIMALS.has(e.name) : e.name === animal))
      .map((e) => ({ e, d: bot.entity.position.distanceTo(e.position) }))
      .filter((x) => x.d < 48)
      .sort((a, b) => a.d - b.d);

    if (!targets.length) {
      misses++;
      const { explore } = await import('./move.js');
      await explore(bot, task, { radius: 48 }).catch(() => {});
      continue;
    }

    const { e } = targets[0];
    const res = await goTo(bot, task, e.position.x, e.position.y, e.position.z, { range: 2, timeoutMs: 25000 });
    if (!res.ok) {
      misses++;
      continue;
    }

    // Beat it down. Animals do not fight back, so no need for the full engine.
    let swings = 0;
    while (bot.entities[e.id] && swings++ < 25) {
      task.check();
      const live = bot.entities[e.id];
      if (!live) break;
      const d = bot.entity.position.distanceTo(live.position);
      if (d > 3.2) {
        await goTo(bot, task, live.position.x, live.position.y, live.position.z, { range: 2, timeoutMs: 8000 });
        continue;
      }
      await bot.lookAt(live.position.offset(0, live.height * 0.8 || 1, 0), true).catch(() => {});
      try {
        bot.attack(live);
      } catch {}
      await wait(620); // respect attack cooldown even on livestock
    }
    if (!bot.entities[e.id]) killed++;
  }

  await collectDrops(bot, task, { radius: 10, quiet: true });
  return { ok: killed > 0, detail: `killed ${killed} animal(s)`, got: killed };
}

/** Pick berries, wheat, carrots, melons — whatever is growing nearby. */
export async function forageCrops(bot, task, { radius = 40 } = {}) {
  const ids = FORAGEABLE.map((n) => bot.mcData.blocksByName[n]?.id).filter((x) => x != null);
  if (!ids.length) return { ok: false, reason: 'nothing foraging-related in this version' };

  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 20 });
  if (!found.length) return { ok: false, reason: 'nothing growing nearby' };

  let picked = 0;
  for (const pos of found.slice(0, 14)) {
    task.check();
    const res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 12000 });
    if (!res.ok) continue;
    const b = bot.blockAt(pos);
    if (!b) continue;
    if (b.name === 'sweet_berry_bush') {
      try {
        await bot.activateBlock(b);
        picked++;
      } catch {}
    } else if (await digBlock(bot, task, b, { safety: false })) picked++;
  }
  await collectDrops(bot, task, { radius: 8, quiet: true });
  return { ok: picked > 0, detail: `foraged ${picked}`, got: picked };
}

/**
 * "get us food" — the whole pipeline: hunt, forage, cook, done.
 */
export async function forageFood(bot, task, { target = 8, urgent = false } = {}) {
  const startCooked = total(bot, COOKED);
  log.act(`getting food (have ${startCooked}, want ${target})`);

  if (urgent) {
    // Starving: eat literally anything, sort quality out later.
    const anyRaw = total(bot, RAW);
    if (anyRaw === 0) {
      await butcher(bot, task, { count: 2 }).catch(() => {});
      const crops = await forageCrops(bot, task, { radius: 32 }).catch(() => ({}));
      if (!crops.ok && total(bot, RAW) === 0) {
        await fish(bot, task, { count: 2 }).catch(() => {});
      }
    }
    return { ok: total(bot, [...RAW, ...COOKED]) > 0, detail: 'grabbed emergency food' };
  }

  let guard = 0;
  while (total(bot, COOKED) + total(bot, RAW) < target && guard++ < 4) {
    task.check();
    await butcher(bot, task, { count: Math.ceil((target - total(bot, RAW)) / 2) }).catch(() => {});
    if (total(bot, RAW) + total(bot, COOKED) >= target) break;
    await forageCrops(bot, task, { radius: 48 }).catch(() => {});
  }

  // Cook what she caught — cooked meat is worth roughly double raw.
  if (total(bot, RAW) > 0) {
    await smelt(bot, task, { item: 'cooked_beef', count: total(bot, RAW), any: 'meat' }).catch((e) => {
      if (e?.aborted) throw e;
    });
  }
  // Wheat into bread as a bonus.
  if (count(bot, 'wheat') >= 3) await craft(bot, task, { item: 'bread', count: Math.floor(count(bot, 'wheat') / 3), optional: true }).catch(() => {});

  const now = total(bot, COOKED);
  return { ok: now > startCooked || now >= target, detail: `food: ${now} cooked items`, got: now };
}

/** Till, plant, and keep a wheat farm — permanent food security. */
export async function farmCrops(bot, task, { crop = 'wheat', plots = 12 } = {}) {
  const seedName = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' }[crop] || 'wheat_seeds';

  let hoe = bot.inventory.items().find((i) => /_hoe$/.test(i.name));
  if (!hoe) {
    await craft(bot, task, { item: 'stone_hoe', count: 1, optional: true }).catch(() => {});
    hoe = bot.inventory.items().find((i) => /_hoe$/.test(i.name));
  }
  if (!hoe) return { ok: false, reason: 'no hoe and cannot make one' };

  let seeds = bot.inventory.items().find((i) => i.name === seedName);
  if (!seeds) {
    // Break grass to get seeds.
    const grassIds = ['short_grass', 'grass', 'tall_grass'].map((n) => bot.mcData.blocksByName[n]?.id).filter((x) => x != null);
    const patches = bot.findBlocks({ matching: grassIds, maxDistance: 32, count: 20 });
    for (const pos of patches.slice(0, 18)) {
      task.check();
      await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 8000 }).catch(() => {});
      const b = bot.blockAt(pos);
      if (b) await digBlock(bot, task, b, { safety: false });
    }
    await collectDrops(bot, task, { radius: 10, quiet: true });
    seeds = bot.inventory.items().find((i) => i.name === seedName);
  }
  if (!seeds) return { ok: false, reason: `no ${seedName} to plant` };

  // Find ground next to water.
  const water = bot.findBlock({ matching: bot.mcData.blocksByName.water.id, maxDistance: 32 });
  const origin = water ? water.position.offset(1, 0, 0) : bot.entity.position.floored();

  let planted = 0;
  for (let dx = 0; dx < 4 && planted < plots; dx++) {
    for (let dz = 0; dz < 4 && planted < plots; dz++) {
      task.check();
      const pos = origin.offset(dx, 0, dz);
      const ground = bot.blockAt(pos);
      const above = bot.blockAt(pos.offset(0, 1, 0));
      if (!ground || !above) continue;
      if (!/grass_block|dirt|farmland/.test(ground.name)) continue;
      if (above.boundingBox !== 'empty') continue;

      if (bot.entity.position.distanceTo(pos) > 3.5) {
        await goTo(bot, task, pos.x, pos.y + 1, pos.z, { range: 2, timeoutMs: 8000 }).catch(() => {});
      }
      try {
        if (ground.name !== 'farmland') {
          await bot.equip(hoe, 'hand');
          await bot.activateBlock(ground);
        }
        const s = bot.inventory.items().find((i) => i.name === seedName);
        if (!s) break;
        await bot.equip(s, 'hand');
        await bot.activateBlock(bot.blockAt(pos));
        planted++;
      } catch (err) {
        if (task.aborted) throw new AbortError();
      }
    }
  }
  const { mem } = await import('../world/memory.js');
  if (planted) mem.addWaypoint('farm', origin);
  return { ok: planted > 0, detail: `planted ${planted} ${crop}`, got: planted };
}

/** Harvest anything fully grown, then replant it. */
export async function harvestCrops(bot, task, { radius = 32 } = {}) {
  const ids = ['wheat', 'carrots', 'potatoes', 'beetroots'].map((n) => bot.mcData.blocksByName[n]?.id).filter((x) => x != null);
  const found = bot.findBlocks({ matching: ids, maxDistance: radius, count: 40 });
  let harvested = 0;

  for (const pos of found) {
    task.check();
    const b = bot.blockAt(pos);
    if (!b) continue;
    // Only fully grown: age 7 for wheat/carrots/potatoes, 3 for beetroot.
    const age = b.getProperties?.().age;
    const ripe = age === undefined || Number(age) >= (b.name === 'beetroots' ? 3 : 7);
    if (!ripe) continue;

    if (bot.entity.position.distanceTo(pos) > 4) {
      const res = await goTo(bot, task, pos.x, pos.y, pos.z, { range: 2, timeoutMs: 8000 });
      if (!res.ok) continue;
    }
    if (await digBlock(bot, task, b, { safety: false })) harvested++;
  }

  await collectDrops(bot, task, { radius: 12, quiet: true });
  if (harvested) await farmCrops(bot, task, { plots: harvested }).catch(() => {});
  return { ok: harvested > 0, detail: `harvested ${harvested}`, got: harvested };
}

export async function fish(bot, task, { count: want = 4 } = {}) {
  let rod = bot.inventory.items().find((i) => i.name === 'fishing_rod');
  if (!rod) {
    await craft(bot, task, { item: 'fishing_rod', count: 1, optional: true }).catch(() => {});
    rod = bot.inventory.items().find((i) => i.name === 'fishing_rod');
  }
  if (!rod) return { ok: false, reason: 'no fishing rod' };

  const water = bot.findBlock({ matching: bot.mcData.blocksByName.water.id, maxDistance: 48 });
  if (!water) return { ok: false, reason: 'no water nearby' };

  await goTo(bot, task, water.position.x, water.position.y + 1, water.position.z, { range: 3, timeoutMs: 30000 });
  await bot.equip(rod, 'hand');

  let caught = 0;
  for (let i = 0; i < want; i++) {
    task.check();
    try {
      await bot.lookAt(water.position.offset(0.5, 0.6, 0.5), true);
      await bot.fish();
      caught++;
    } catch (err) {
      if (task.aborted) throw new AbortError();
      break;
    }
  }
  return { ok: caught > 0, detail: `caught ${caught} fish`, got: caught };
}
