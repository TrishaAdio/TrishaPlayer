/**
 * ENCHANTING — the largest single power jump in the game.
 *
 * Protection IV on four pieces cuts incoming damage roughly in half; Sharpness V
 * adds about 3 hearts per swing. No amount of combat tuning competes with that, so
 * this is what "strongest" actually requires once diamond gear is on.
 *
 * The chain she has to solve unattended:
 *   obsidian (mined or cast from lava)  ->  enchanting table
 *   sugar cane -> paper, cows -> leather  ->  books  ->  bookshelves x15
 *   XP to level 30  ->  enchant sword, armour, pickaxe, bow
 */
import { Vec3 } from 'vec3';
import { log } from '../util/log.js';
import { mem } from '../world/memory.js';
import { AbortError } from '../task.js';
import { goTo } from './move.js';
import { craft } from './craft.js';
import { mine, collectDrops, digBlock, expandBlockNames } from './gather.js';
import { placeAt } from './build.js';
import { butcher } from './farm.js';
import { equipBest } from '../reflex/gear.js';

const UP = new Vec3(0, 1, 0);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const count = (bot, n) => bot.inventory.items().reduce((a, i) => (i.name === n ? a + i.count : a), 0);
const item = (bot, n) => bot.inventory.items().find((i) => i.name === n);

/** Enchantments worth spending levels on, per item class. */
export const WANTED = {
  sword: ['sharpness', 'looting', 'unbreaking', 'fire_aspect', 'sweeping'],
  armor: ['protection', 'unbreaking', 'mending', 'thorns'],
  pickaxe: ['efficiency', 'fortune', 'unbreaking'],
  bow: ['power', 'infinity', 'unbreaking', 'punch'],
};

/**
 * Obsidian. Mined if any exists nearby, otherwise cast by pouring water onto
 * standing lava — which is how a real player gets it before they have a portal.
 * Either way it needs a diamond pickaxe; nothing else can break it.
 */
export async function getObsidian(bot, task, { count: want = 10 } = {}) {
  if (count(bot, 'obsidian') >= want) return { ok: true, detail: `already have ${want} obsidian` };

  const pick = item(bot, 'diamond_pickaxe') || item(bot, 'netherite_pickaxe');
  if (!pick) return { ok: false, reason: 'need a diamond pickaxe to break obsidian' };

  // 1. Natural obsidian first — cheapest route.
  const natural = await mine(bot, task, { block: 'obsidian', count: want, optional: true }).catch((e) => {
    if (e?.aborted) throw e;
    return { ok: false };
  });
  if (count(bot, 'obsidian') >= want) {
    return { ok: true, detail: `mined ${count(bot, 'obsidian')} obsidian` };
  }

  // 2. Cast it: water onto a lava source turns it to obsidian.
  const made = await castObsidian(bot, task, { count: want - count(bot, 'obsidian') });
  const have = count(bot, 'obsidian');
  return {
    ok: have > 0,
    detail: `obsidian: ${have}${made.detail ? ` (${made.detail})` : ''}`,
    got: have,
  };
}

/** Pour water on lava, break the obsidian, repeat. Refills the bucket as it goes. */
export async function castObsidian(bot, task, { count: want = 10 } = {}) {
  let bucket = item(bot, 'water_bucket');
  if (!bucket) {
    const { fillBucket } = await import('./misc.js');
    const filled = await fillBucket(bot, task, { fluid: 'water' });
    if (!filled.ok) return { ok: false, reason: 'no water bucket to cast obsidian with' };
    bucket = item(bot, 'water_bucket');
  }

  let made = 0;
  let attempts = 0;
  while (made < want && attempts++ < want * 3) {
    task.check();

    // A lava source block with air above it is castable.
    const lava = bot.findBlock({
      matching: (b) => {
        if (!b || b.name !== 'lava') return false;
        const level = b.getProperties?.().level;
        if (level !== undefined && Number(level) !== 0) return false; // source only
        const above = bot.blockAt(b.position.offset(0, 1, 0));
        return above && above.boundingBox === 'empty';
      },
      maxDistance: 48,
    });
    if (!lava) return { ok: made > 0, detail: `cast ${made}, no more reachable lava`, got: made };

    // Stand next to it, never on top of it.
    const stand = lava.position.offset(2, 1, 0);
    await goTo(bot, task, stand.x, stand.y, stand.z, { range: 2, timeoutMs: 30000 }).catch(() => {});
    if (bot.entity.position.distanceTo(lava.position) > 5) continue;

    try {
      const b = item(bot, 'water_bucket');
      if (!b) {
        const { fillBucket } = await import('./misc.js');
        await fillBucket(bot, task, { fluid: 'water' });
        continue;
      }
      await bot.equip(b, 'hand');
      await bot.lookAt(lava.position.offset(0.5, 1.1, 0.5), true);
      bot.activateItem();
      await wait(300);
      bot.deactivateItem();
      await wait(500);

      const now = bot.blockAt(lava.position);
      if (now?.name === 'obsidian') {
        if (await digBlock(bot, task, now, { safety: false })) {
          made++;
          log.act(`cast obsidian ${made}/${want}`);
        }
      }
      // Recover the water so the loop can continue.
      const { Clutch } = await import('../reflex/clutch.js');
      await new Clutch(bot, { emit() {} }).recoverWater().catch(() => {});
    } catch (err) {
      if (task.aborted) throw new AbortError();
    }
  }
  await collectDrops(bot, task, { radius: 6, quiet: true });
  return { ok: made > 0, detail: `cast ${made} obsidian`, got: made };
}

/** Paper from sugar cane, leather from cows, then books. */
export async function makeBooks(bot, task, { count: want = 15 } = {}) {
  if (count(bot, 'book') >= want) return { ok: true, detail: `already have ${want} books` };

  const needed = want - count(bot, 'book');

  // Paper: 3 sugar cane -> 3 paper. Each book needs 3 paper + 1 leather.
  const paperNeeded = needed * 3;
  if (count(bot, 'paper') < paperNeeded) {
    const caneNeeded = paperNeeded - count(bot, 'paper');
    if (count(bot, 'sugar_cane') < caneNeeded) {
      await mine(bot, task, { block: 'sugar_cane', count: caneNeeded, optional: true }).catch(() => {});
    }
    if (count(bot, 'sugar_cane') >= 3) {
      await craft(bot, task, { item: 'paper', count: paperNeeded, optional: true }).catch(() => {});
    }
  }

  // Leather: cows and horses drop it.
  if (count(bot, 'leather') < needed) {
    const short = needed - count(bot, 'leather');
    log.act(`need ${short} leather, going hunting`);
    await butcher(bot, task, { animal: 'cow', count: Math.max(2, short) }).catch(() => {});
  }

  const res = await craft(bot, task, { item: 'book', count: want, optional: true }).catch(() => ({ ok: false }));
  const have = count(bot, 'book');
  return {
    ok: have > 0,
    detail: `books: ${have}/${want}`,
    got: have,
    reason: have < want ? `only ${have} books — short on ${count(bot, 'leather') < needed ? 'leather' : 'paper'}` : undefined,
  };
}

/** The table itself: 4 obsidian, 2 diamonds, 1 book. */
export async function ensureEnchantingTable(bot, task) {
  const existing = bot.findBlock({ matching: bot.mcData.blocksByName.enchanting_table?.id, maxDistance: 32 });
  if (existing) {
    if (bot.entity.position.distanceTo(existing.position) > 3.2) {
      await goTo(bot, task, existing.position.x, existing.position.y, existing.position.z, { range: 2 }).catch(() => {});
    }
    return existing;
  }

  if (!item(bot, 'enchanting_table')) {
    if (count(bot, 'obsidian') < 4) {
      const obs = await getObsidian(bot, task, { count: 4 });
      if (!obs.ok || count(bot, 'obsidian') < 4) return null;
    }
    if (count(bot, 'diamond') < 2) return null;
    if (count(bot, 'book') < 1) {
      await makeBooks(bot, task, { count: 1 }).catch(() => {});
      if (count(bot, 'book') < 1) return null;
    }
    const made = await craft(bot, task, { item: 'enchanting_table', count: 1 });
    if (!made.ok) return null;
  }

  const spot = bot.entity.position.floored().offset(1, 0, 0);
  if (await placeAt(bot, task, spot, 'enchanting_table')) {
    const block = bot.blockAt(spot);
    mem.addWaypoint('enchanting', spot);
    log.act('enchanting table placed');
    return block;
  }
  return null;
}

/**
 * Bookshelves raise the maximum enchant level. Fifteen of them, one block of air
 * away from the table, is what unlocks level 30 enchants — the whole point.
 */
export async function buildBookshelves(bot, task, { count: want = 15 } = {}) {
  const table = await ensureEnchantingTable(bot, task);
  if (!table) return { ok: false, reason: 'no enchanting table to build around' };

  if (count(bot, 'bookshelf') < want) {
    const short = want - count(bot, 'bookshelf');
    await makeBooks(bot, task, { count: short * 3 }).catch(() => {});
    await craft(bot, task, { item: 'bookshelf', count: want, optional: true }).catch(() => {});
  }
  const have = count(bot, 'bookshelf');
  if (!have) return { ok: false, reason: 'no bookshelves and not enough books/planks to make them' };

  // The ring sits 2 blocks out from the table, at table level and one above.
  const t = table.position;
  const ring = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue; // perimeter only
      ring.push({ dx, dz });
    }
  }

  let placed = 0;
  for (const dy of [0, 1]) {
    for (const { dx, dz } of ring) {
      task.check();
      if (placed >= have) break;
      const pos = t.offset(dx, dy, dz);
      const at = bot.blockAt(pos);
      if (!at || at.boundingBox === 'block') continue;
      if (await placeAt(bot, task, pos, 'bookshelf')) placed++;
    }
  }
  log.act(`placed ${placed} bookshelves`);
  return { ok: placed > 0, detail: `${placed} bookshelves around the table`, got: placed };
}

/**
 * XP. Ore blocks and mob kills both give it. Mining is safer and more predictable
 * than mob farming, so she leans on ore and only fights what comes to her.
 */
export async function xpGrind(bot, task, { level = 30 } = {}) {
  const start = bot.experience?.level ?? 0;
  if (start >= level) return { ok: true, detail: `already level ${start}` };

  log.act(`grinding XP: level ${start} -> ${level}`);
  const XP_ORES = ['coal_ore', 'lapis_ore', 'redstone_ore', 'diamond_ore', 'emerald_ore', 'nether_quartz_ore'];
  let guard = 0;

  while ((bot.experience?.level ?? 0) < level && guard++ < 14) {
    task.check();
    const before = bot.experience?.level ?? 0;

    for (const ore of XP_ORES) {
      task.check();
      if ((bot.experience?.level ?? 0) >= level) break;
      await mine(bot, task, { block: ore, count: 24, optional: true }).catch((e) => {
        if (e?.aborted) throw e;
      });
    }

    const now = bot.experience?.level ?? 0;
    if (now === before) {
      // No ore in range — move somewhere new rather than spinning.
      const { explore } = await import('./move.js');
      await explore(bot, task, { radius: 64 }).catch(() => {});
    }
  }

  const end = bot.experience?.level ?? 0;
  return { ok: end > start, detail: `level ${end}`, got: end };
}

function classOf(name) {
  if (/_sword$/.test(name)) return 'sword';
  if (/_helmet$|_chestplate$|_leggings$|_boots$/.test(name)) return 'armor';
  if (/_pickaxe$|_axe$|_shovel$/.test(name)) return 'pickaxe';
  if (/^bow$|^crossbow$/.test(name)) return 'bow';
  return null;
}

/**
 * Enchant one item. Picks the best affordable slot: slot 2 is the strongest
 * enchant the table can offer and is what 15 bookshelves exist to unlock.
 */
export async function enchantItem(bot, task, { item: name, choice = 2 } = {}) {
  const target = item(bot, String(name));
  if (!target) return { ok: false, reason: `no ${name} to enchant` };
  if (target.nbt && JSON.stringify(target.nbt).includes('nchant')) {
    return { ok: true, detail: `${name} is already enchanted` };
  }

  const lapis = item(bot, 'lapis_lazuli');
  if (!lapis || lapis.count < 3) {
    await mine(bot, task, { block: 'lapis_ore', count: 6, optional: true }).catch(() => {});
    if ((item(bot, 'lapis_lazuli')?.count ?? 0) < 1) return { ok: false, reason: 'no lapis lazuli' };
  }

  const block = await ensureEnchantingTable(bot, task);
  if (!block) return { ok: false, reason: 'no enchanting table' };

  let table;
  try {
    table = await bot.openEnchantmentTable(block);
  } catch (err) {
    return { ok: false, reason: `cannot open enchanting table: ${err.message}` };
  }

  try {
    await table.putTargetItem(target);
    const lap = item(bot, 'lapis_lazuli');
    if (lap) await table.putLapis(lap).catch(() => {});
    await wait(700);

    // Pick the highest slot she can actually afford.
    const options = table.enchantments || [];
    let pick = -1;
    for (let i = Math.min(choice, options.length - 1); i >= 0; i--) {
      const o = options[i];
      if (!o || o.level === -1) continue;
      if ((bot.experience?.level ?? 0) >= (o.level ?? 99)) {
        pick = i;
        break;
      }
    }
    if (pick === -1) {
      const need = options.find((o) => o && o.level > 0)?.level;
      await table.takeTargetItem().catch(() => {});
      return { ok: false, reason: `not enough levels to enchant ${name}${need ? ` (needs ${need})` : ''}` };
    }

    await table.enchant(pick);
    await wait(600);
    await table.takeTargetItem().catch(() => {});
    log.act(`enchanted ${name} (slot ${pick + 1})`);
    mem.note(`enchanted ${name}`);
    return { ok: true, detail: `enchanted ${name}` };
  } catch (err) {
    if (task.aborted) throw new AbortError();
    return { ok: false, reason: `enchant failed: ${err.message}` };
  } finally {
    try {
      table.close();
    } catch {}
  }
}

/** Enchant the whole kit, best items first, until the levels run out. */
export async function enchantKit(bot, task, { minLevel = 30 } = {}) {
  const order = [
    'netherite_sword', 'diamond_sword', 'netherite_chestplate', 'diamond_chestplate',
    'netherite_helmet', 'diamond_helmet', 'netherite_leggings', 'diamond_leggings',
    'netherite_boots', 'diamond_boots', 'netherite_pickaxe', 'diamond_pickaxe', 'bow',
  ];
  const done = [];
  const failed = [];

  for (const name of order) {
    task.check();
    if (!item(bot, name)) continue;
    if ((bot.experience?.level ?? 0) < 3) {
      await xpGrind(bot, task, { level: Math.min(minLevel, 15) }).catch(() => {});
    }
    const res = await enchantItem(bot, task, { item: name, choice: 2 }).catch((e) => {
      if (e?.aborted) throw e;
      return { ok: false, reason: e.message };
    });
    if (res.ok) done.push(name);
    else failed.push(`${name}: ${res.reason}`);
  }

  await equipBest(bot).catch(() => {});
  return {
    ok: done.length > 0,
    detail: done.length ? `enchanted ${done.length} item(s): ${done.join(', ')}` : `nothing enchanted (${failed[0] || 'no gear'})`,
    got: done.length,
  };
}
