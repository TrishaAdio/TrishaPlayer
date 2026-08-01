/**
 * Chests, handing things over, and inventory hygiene.
 */
import { Vec3 } from 'vec3';
import { log } from '../util/log.js';
import { mem } from '../world/memory.js';
import { config } from '../config.js';
import { goTo } from './move.js';
import { craft } from './craft.js';
import { placeAt } from './build.js';

const KEEP_ALWAYS = [
  /_sword$/, /_pickaxe$/, /_axe$/, /_shovel$/, /_hoe$/, /^shield$/, /_helmet$/, /_chestplate$/,
  /_leggings$/, /_boots$/, /^torch$/, /^water_bucket$/, /^bucket$/, /^totem_of_undying$/,
  /^ender_pearl$/, /^golden_apple$/, /^enchanted_golden_apple$/, /^cooked_/, /^bread$/,
  /^crafting_table$/, /^furnace$/, /^bow$/, /^arrow$/,
];

const isKeeper = (name, keepSpec) => {
  if (KEEP_ALWAYS.some((re) => re.test(name))) return true;
  if (!keepSpec) return false;
  const tags = String(keepSpec).split(',').map((s) => s.trim().toLowerCase());
  if (tags.includes('blocks') && /cobblestone|stone|planks|dirt|deepslate/.test(name)) return true;
  if (tags.includes('food') && /cooked_|bread|carrot|potato|apple|melon/.test(name)) return true;
  if (tags.includes('torch') && name === 'torch') return true;
  if (tags.includes('gear') && /_sword|_pickaxe|_axe|shield|_helmet|_chestplate|_leggings|_boots/.test(name)) return true;
  return tags.includes(name);
};

/** Nearest chest: one she remembers, one she can see, or a new one she places. */
export async function findChest(bot, task, { create = true } = {}) {
  const ids = ['chest', 'trapped_chest', 'barrel'].map((n) => bot.mcData.blocksByName[n]?.id).filter((x) => x != null);
  let block = bot.findBlock({ matching: ids, maxDistance: 32 });

  if (!block) {
    for (const c of mem.all.chests) {
      const pos = new Vec3(c.x, c.y, c.z);
      if (bot.entity.position.distanceTo(pos) > 120) continue;
      const res = await goTo(bot, task, c.x, c.y, c.z, { range: 3, timeoutMs: 60000 });
      if (res.ok) {
        block = bot.blockAt(pos);
        if (block && ids.includes(block.type)) break;
      }
    }
  }

  if (!block && create) {
    let item = bot.inventory.items().find((i) => i.name === 'chest');
    if (!item) {
      await craft(bot, task, { item: 'chest', count: 1, optional: true }).catch(() => {});
      item = bot.inventory.items().find((i) => i.name === 'chest');
    }
    if (item) {
      const spot = bot.entity.position.floored().offset(1, 0, 0);
      if (await placeAt(bot, task, spot, 'chest')) {
        block = bot.blockAt(spot);
        mem.addChest(spot, 'placed by trisha');
      }
    }
  }

  if (block && bot.entity.position.distanceTo(block.position) > 3.2) {
    await goTo(bot, task, block.position.x, block.position.y, block.position.z, { range: 2 });
  }
  return block;
}

export async function deposit(bot, task, { keep = 'gear,food,torch,blocks', items = null } = {}) {
  const chest = await findChest(bot, task, { create: true });
  if (!chest) return { ok: false, reason: 'no chest and nothing to make one from' };

  let container;
  try {
    container = await bot.openContainer(chest);
  } catch (err) {
    return { ok: false, reason: `cannot open chest: ${err.message}` };
  }

  let moved = 0;
  try {
    const wanted = items ? String(items).split(',').map((s) => s.trim()) : null;
    for (const it of bot.inventory.items()) {
      task.check();
      if (wanted) {
        if (!wanted.includes(it.name)) continue;
      } else if (isKeeper(it.name, keep)) continue;

      try {
        await container.deposit(it.type, null, it.count);
        moved += it.count;
      } catch {}
    }
    mem.addChest(chest.position, 'loot chest');
  } finally {
    try {
      container.close();
    } catch {}
  }
  log.act(`deposited ${moved} items`);
  return { ok: true, detail: `stored ${moved} items` };
}

export async function withdraw(bot, task, { item, count: want = 1 } = {}) {
  const chest = await findChest(bot, task, { create: false });
  if (!chest) return { ok: false, reason: 'no chest nearby' };

  let container;
  try {
    container = await bot.openContainer(chest);
  } catch (err) {
    return { ok: false, reason: `cannot open chest: ${err.message}` };
  }
  try {
    const def = bot.mcData.itemsByName[String(item).toLowerCase()];
    if (!def) return { ok: false, reason: `no such item ${item}` };
    await container.withdraw(def.id, null, want);
    return { ok: true, detail: `took ${want}x ${item}` };
  } catch (err) {
    return { ok: false, reason: `nothing like that in the chest` };
  } finally {
    try {
      container.close();
    } catch {}
  }
}

/** Walk to a player and drop items at their feet. */
export async function give(bot, task, { player, item, count: want = 1 } = {}) {
  const name = player || config.owner;
  const target = bot.players[name]?.entity;
  if (!target) return { ok: false, reason: `cannot see ${name}` };

  const res = await goTo(bot, task, target.position.x, target.position.y, target.position.z, { range: 2, timeoutMs: 60000 });
  if (!res.ok) return res;

  await bot.lookAt(target.position.offset(0, 1.5, 0), true).catch(() => {});

  const wanted = String(item || '').toLowerCase().replace(/\s+/g, '_');
  let tossed = 0;

  if (!wanted || wanted === 'food') {
    const foods = bot.inventory.items().filter((i) => /cooked_|bread|baked_potato|carrot|apple|melon_slice|golden_carrot/.test(i.name));
    for (const f of foods) {
      const give = Math.min(f.count, want > 1 ? want : Math.ceil(f.count / 2));
      try {
        await bot.toss(f.type, null, give);
        tossed += give;
      } catch {}
      if (tossed >= want) break;
    }
  } else {
    const it = bot.inventory.items().find((i) => i.name === wanted || i.name.includes(wanted));
    if (!it) return { ok: false, reason: `no ${wanted} to give` };
    const give = Math.min(it.count, want);
    try {
      await bot.toss(it.type, null, give);
      tossed = give;
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }
  return { ok: tossed > 0, detail: `gave ${name} ${tossed} item(s)`, got: tossed };
}

export async function dropItem(bot, task, { item, count: want = 1 } = {}) {
  const it = bot.inventory.items().find((i) => i.name === String(item).toLowerCase());
  if (!it) return { ok: false, reason: `no ${item}` };
  try {
    await bot.toss(it.type, null, Math.min(want, it.count));
    return { ok: true, detail: `dropped ${item}` };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}


/**
 * THROW AWAY THE GRAVEL.
 *
 * A live run reached 33 ingots' worth of iron and then could not smelt any of it:
 *   21:16:59  smelt -> FAILED: destination full
 * She was carrying 396 items — granite, tuff, dirt and gravel swept up while branch
 * mining — so there was nowhere for the ingots to land. Mining fills a pack with rubble;
 * a player empties it. Anything genuinely useful is protected by name.
 */
const JUNK = [
  'granite', 'diorite', 'andesite', 'tuff', 'gravel', 'dirt', 'coarse_dirt', 'sand', 'red_sand',
  'deepslate', 'cobbled_deepslate', 'clay', 'calcite', 'smooth_basalt', 'basalt', 'netherrack',
  'rooted_dirt', 'mud', 'sandstone', 'grass_block', 'podzol', 'mycelium', 'flint', 'seagrass',
  'kelp', 'short_grass', 'tall_grass', 'fern', 'dead_bush', 'poppy', 'dandelion', 'lilac',
];

/** Keep a working amount of cobblestone — it is tools, furnaces and shelter. */
const KEEP_SOME = { cobblestone: 64, stick: 32, torch: 32, coal: 32 };

export async function dropJunk(bot, task, { aggressive = false } = {}) {
  let dropped = 0;
  for (const item of [...bot.inventory.items()]) {
    task.check();
    const cap = KEEP_SOME[item.name];
    if (cap != null) {
      // Trim an overflowing stack rather than dumping something she needs.
      const excess = item.count - cap;
      if (excess > 0) {
        try {
          await bot.toss(item.type, null, excess);
          dropped += excess;
        } catch {}
      }
      continue;
    }
    if (!JUNK.includes(item.name)) continue;
    if (!aggressive && /cobblestone|coal|stick|torch/.test(item.name)) continue;
    try {
      await bot.toss(item.type, null, item.count);
      dropped += item.count;
      await task.sleep(90);
    } catch {}
  }
  if (dropped) log.act(`[tidy] dropped ${dropped} items of rubble to make room`);
  return { ok: true, detail: `dropped ${dropped}`, got: dropped };
}
