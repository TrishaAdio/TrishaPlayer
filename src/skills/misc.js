import { Vec3 } from 'vec3';
import { log } from '../util/log.js';
import { mem } from '../world/memory.js';
import { goTo } from './move.js';
import { craft } from './craft.js';
import { equipBest } from '../reflex/gear.js';

/** Sleep through the night — skips the mob hours and sets her respawn point. */
export async function sleepNow(bot, task) {
  const bedIds = Object.keys(bot.mcData.blocksByName)
    .filter((n) => /_bed$/.test(n))
    .map((n) => bot.mcData.blocksByName[n].id);

  let bed = bot.findBlock({ matching: bedIds, maxDistance: 48 });

  if (!bed) {
    const remembered = mem.all.bed;
    if (remembered) {
      const res = await goTo(bot, task, remembered.x, remembered.y, remembered.z, { range: 2, timeoutMs: 60000 });
      if (res.ok) bed = bot.findBlock({ matching: bedIds, maxDistance: 8 });
    }
  }
  if (!bed) {
    const made = await craft(bot, task, { item: 'white_bed', count: 1, optional: true });
    if (made.ok) {
      const { placeAt } = await import('./build.js');
      const spot = bot.entity.position.floored().offset(1, 0, 0);
      const item = bot.inventory.items().find((i) => /_bed$/.test(i.name));
      if (item && (await placeAt(bot, task, spot, item.name))) bed = bot.blockAt(spot);
    }
  }
  if (!bed) return { ok: false, reason: 'no bed and nothing to make one from' };

  if (bot.entity.position.distanceTo(bed.position) > 3) {
    const res = await goTo(bot, task, bed.position.x, bed.position.y, bed.position.z, { range: 2 });
    if (!res.ok) return res;
  }
  mem.setBed(bed.position);

  try {
    await bot.sleep(bed);
    log.act('sleeping');
    // Stay asleep until morning or until something wakes her.
    let guard = 0;
    while (bot.isSleeping && guard++ < 200) {
      task.check();
      await task.sleep(500);
    }
    return { ok: true, detail: 'slept through the night' };
  } catch (err) {
    const msg = err.message || '';
    if (/monsters nearby/i.test(msg)) return { ok: false, reason: 'monsters nearby, cannot sleep' };
    if (/day|not night/i.test(msg)) return { ok: false, reason: 'not night yet' };
    return { ok: false, reason: msg };
  }
}

/**
 * Wool for a bed. Shears if she has them (3 wool per sheep, sheep survives),
 * otherwise she kills them — a sheep drops 1 wool, so 3 sheep for one bed.
 */
export async function getWool(bot, task, { count: want = 3 } = {}) {
  const have = () => bot.inventory.items().reduce((n, i) => (/_wool$/.test(i.name) ? n + i.count : n), 0);
  if (have() >= want) return { ok: true, detail: `already have ${have()} wool` };

  const { butcher } = await import('./farm.js');
  const { collectDrops } = await import('./gather.js');
  const shears = bot.inventory.items().find((i) => i.name === 'shears');

  let guard = 0;
  while (have() < want && guard++ < 5) {
    task.check();
    const sheep = Object.values(bot.entities)
      .filter((e) => e?.name === 'sheep' && e.position)
      .map((e) => ({ e, d: bot.entity.position.distanceTo(e.position) }))
      .sort((a, b) => a.d - b.d)[0];

    if (!sheep) {
      const { explore } = await import('./move.js');
      await explore(bot, task, { radius: 56 }).catch(() => {});
      continue;
    }

    if (shears) {
      // Shearing yields more wool and leaves the sheep alive to regrow it.
      const { goTo } = await import('./move.js');
      await goTo(bot, task, sheep.e.position.x, sheep.e.position.y, sheep.e.position.z, { range: 2, timeoutMs: 20000 }).catch(() => {});
      try {
        await bot.equip(shears, 'hand');
        await bot.lookAt(sheep.e.position.offset(0, 0.8, 0), true);
        await bot.activateEntity(sheep.e);
        await task.sleep(600);
      } catch {}
      await collectDrops(bot, task, { radius: 6, quiet: true }).catch(() => {});
    } else {
      await butcher(bot, task, { animal: 'sheep', count: Math.max(1, want - have()) }).catch(() => {});
    }
  }

  const got = have();
  return { ok: got > 0, detail: `wool: ${got}/${want}`, got, reason: got < want ? 'not enough sheep around' : undefined };
}

/** Place a bed she is carrying and remember where it is. */
export async function placeBed(bot, task) {
  const bed = bot.inventory.items().find((i) => /_bed$/.test(i.name));
  if (!bed) return { ok: false, reason: 'no bed to place' };

  const { placeAt } = await import('./build.js');
  const base = bot.entity.position.floored();
  // A bed needs two free blocks side by side, with solid ground under both.
  for (const off of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2]]) {
    task.check();
    const pos = base.offset(off[0], 0, off[1]);
    const here = bot.blockAt(pos);
    const next = bot.blockAt(pos.offset(off[0] === 0 ? 1 : 0, 0, off[0] === 0 ? 0 : 1));
    const floor = bot.blockAt(pos.offset(0, -1, 0));
    if (!here || !next || !floor) continue;
    if (here.boundingBox !== 'empty' || next.boundingBox !== 'empty') continue;
    if (floor.boundingBox !== 'block') continue;

    if (await placeAt(bot, task, pos, bed.name)) {
      mem.setBed(pos);
      log.act(`bed placed at ${pos.x},${pos.y},${pos.z}`);
      return { ok: true, detail: 'bed placed' };
    }
  }
  return { ok: false, reason: 'no flat two-block space for a bed' };
}

export async function wakeUp(bot) {
  try {
    await bot.wake();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** A filled water bucket is her lava insurance and her MLG clutch. */
export async function fillBucket(bot, task, { fluid = 'water' } = {}) {
  let bucket = bot.inventory.items().find((i) => i.name === 'bucket');
  if (!bucket) {
    if (bot.inventory.items().some((i) => i.name === `${fluid}_bucket`)) {
      return { ok: true, detail: `already has a ${fluid} bucket` };
    }
    const made = await craft(bot, task, { item: 'bucket', count: 1, optional: true });
    if (!made.ok) return { ok: false, reason: 'need 3 iron for a bucket' };
    bucket = bot.inventory.items().find((i) => i.name === 'bucket');
  }
  if (!bucket) return { ok: false, reason: 'no bucket' };

  const source = bot.findBlock({
    matching: (b) => b?.name === fluid,
    maxDistance: 64,
  });
  if (!source) return { ok: false, reason: `no ${fluid} nearby` };

  const res = await goTo(bot, task, source.position.x, source.position.y + 1, source.position.z, { range: 2, timeoutMs: 60000 });
  if (!res.ok) return res;

  try {
    await bot.equip(bucket, 'hand');
    await bot.lookAt(source.position.offset(0.5, 0.5, 0.5), true);
    bot.activateItem();
    await task.sleep(250);
    bot.deactivateItem();
    const filled = bot.inventory.items().some((i) => i.name === `${fluid}_bucket`);
    return filled ? { ok: true, detail: `filled a ${fluid} bucket` } : { ok: false, reason: 'bucket did not fill' };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

export async function equipBestAction(bot) {
  const r = await equipBest(bot);
  return { ok: true, detail: `armour ${r.armor}, shield ${r.shield}, weapon ${r.weapon}` };
}

export async function idle(bot, task, { seconds = 5 } = {}) {
  await task.sleep(Math.min(120, Math.max(1, seconds)) * 1000);
  return { ok: true, detail: 'waited' };
}

export async function lookAtPlayer(bot, task, { player } = {}) {
  const e = bot.players[player]?.entity;
  if (!e) return { ok: false, reason: `cannot see ${player}` };
  await bot.lookAt(e.position.offset(0, 1.6, 0), true).catch(() => {});
  return { ok: true };
}
