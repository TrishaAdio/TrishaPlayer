/**
 * Isolates the digging failure.
 *
 * Eleven consecutive digs stalled over nine minutes on a live run, achieving nothing.
 * The hypothesis, from a `panic: drowning` immediately preceding them: she was digging
 * with no pickaxe AND while floating in water, and Minecraft applies a 5x penalty for
 * mining while not on the ground. Stone by hand is 7.5s; times five that is 37s, which
 * blows past any sane timeout — so every dig "stalls" forever.
 *
 * This measures the four cases directly, with the server telling us the truth.
 */
import mineflayer from 'mineflayer';
import mcDataLoader from 'minecraft-data';
import fs from 'node:fs';
import { Vec3 } from 'vec3';

const FIFO = process.env.SPAR_FIFO || '';
const cmd = (l) => {
  if (FIFO) fs.writeFileSync(FIFO, `${l}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || '127.0.0.1',
  port: Number(process.env.MC_PORT || 25565),
  username: 'Digger',
  auth: 'offline',
  version: process.env.MC_VERSION || '1.21.4',
  hideErrors: true,
});

bot.on('error', (e) => console.log(`error: ${e.message}`));

async function tryDig(label, block, expectTool) {
  if (!block) {
    console.log(`  ${label}: no block found`);
    return;
  }
  const dist = bot.entity.position.distanceTo(block.position);
  let digTime = null;
  try {
    digTime = bot.digTime(block);
  } catch (e) {
    digTime = `error: ${e.message}`;
  }
  const canDig = bot.canDigBlock(block);
  const held = bot.heldItem?.name || 'FIST';
  const onGround = bot.entity.onGround;
  const inWater = bot.entity.isInWater;

  console.log(`\n  ${label}`);
  console.log(`    block=${block.name} dist=${dist.toFixed(2)} held=${held} onGround=${onGround} inWater=${inWater}`);
  console.log(`    canDigBlock=${canDig} digTime=${digTime}ms  harvestTools=${JSON.stringify(bot.mcData.blocks[block.type]?.harvestTools || null)}`);

  const t0 = Date.now();
  let outcome;
  try {
    await Promise.race([
      bot.dig(block),
      new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT at 25s')), 25000)),
    ]);
    outcome = `broke it in ${Date.now() - t0}ms`;
  } catch (err) {
    outcome = `FAILED after ${Date.now() - t0}ms: ${err.message}`;
    try {
      bot.stopDigging();
    } catch {}
  }
  console.log(`    result: ${outcome}`);
}

bot.once('spawn', async () => {
  bot.mcData = mcDataLoader(bot.version);
  await sleep(3000);

  const p = bot.entity.position.floored();
  cmd('gamerule sendCommandFeedback false');
  cmd('gamerule doDaylightCycle false');
  cmd('time set day');
  cmd(`clear Digger`);
  // A dry stone platform to stand on, and a wall of stone to mine.
  cmd(`fill ${p.x - 4} ${p.y - 1} ${p.z - 4} ${p.x + 4} ${p.y - 1} ${p.z + 4} stone`);
  cmd(`fill ${p.x - 4} ${p.y} ${p.z - 4} ${p.x + 4} ${p.y + 3} ${p.z + 4} air`);
  cmd(`setblock ${p.x + 2} ${p.y} ${p.z} stone`);
  cmd(`setblock ${p.x + 2} ${p.y} ${p.z + 1} stone`);
  cmd(`setblock ${p.x + 2} ${p.y} ${p.z + 2} stone`);
  cmd(`tp Digger ${p.x} ${p.y} ${p.z}`);
  await sleep(3500);

  console.log(`\n${'='.repeat(64)}`);
  console.log('  DIG DIAGNOSIS');
  console.log(`${'='.repeat(64)}`);

  // 1. Stone, bare hands, standing on solid ground.
  await tryDig('CASE 1  stone / FIST / on ground', bot.blockAt(new Vec3(p.x + 2, p.y, p.z)));

  // 2. Stone with the correct tool.
  cmd(`give Digger stone_pickaxe 1`);
  await sleep(2500);
  const pick = bot.inventory.items().find((i) => i.name === 'stone_pickaxe');
  if (pick) await bot.equip(pick, 'hand').catch(() => {});
  await tryDig('CASE 2  stone / STONE PICKAXE / on ground', bot.blockAt(new Vec3(p.x + 2, p.y, p.z + 1)));

  // 3. The suspected killer: mining while floating in water.
  cmd(`fill ${p.x - 2} ${p.y} ${p.z - 3} ${p.x + 2} ${p.y + 2} ${p.z - 2} water`);
  cmd(`setblock ${p.x + 2} ${p.y} ${p.z - 2} stone`);
  cmd(`tp Digger ${p.x} ${p.y + 1} ${p.z - 2}`);
  await sleep(4000);
  console.log(`\n  (now at ${bot.entity.position.floored()}, inWater=${bot.entity.isInWater}, onGround=${bot.entity.onGround})`);
  await tryDig('CASE 3  stone / PICKAXE / IN WATER', bot.blockAt(new Vec3(p.x + 2, p.y, p.z - 2)));

  // 4. Out of reach, to confirm what that failure looks like.
  cmd(`tp Digger ${p.x} ${p.y} ${p.z + 8}`);
  cmd(`setblock ${p.x} ${p.y} ${p.z - 6} stone`);
  await sleep(3000);
  await tryDig('CASE 4  stone / PICKAXE / OUT OF REACH (~14 blocks)', bot.blockAt(new Vec3(p.x, p.y, p.z - 6)));

  console.log(`\n${'='.repeat(64)}\n`);
  bot.quit('done');
  setTimeout(() => process.exit(0), 500);
});

setTimeout(() => {
  console.log('dig test timed out overall');
  process.exit(3);
}, 180000);
