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
