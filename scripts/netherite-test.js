/**
 * Verifies the netherite smithing path end to end.
 *
 * The upgrade template only generates in bastion loot, which an unattended bot
 * cannot reliably reach — so rather than claim the path works, this grants the three
 * inputs through the server console and then drives the real `upgradeNetherite`
 * action to prove the smithing-window handling is correct.
 *
 * Usage: SPAR_FIFO=... node scripts/netherite-test.js
 */
import fs from 'node:fs';
import mineflayer from 'mineflayer';
import mcDataLoader from 'minecraft-data';
import { installMovement } from '../src/skills/move.js';
import { Task } from '../src/task.js';
import { upgradeNetherite, ensureSmithingTable } from '../src/skills/nether.js';

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION || '1.21.4';
const FIFO = process.env.SPAR_FIFO || '';
const NAME = 'Smithy';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = (line) => {
  if (FIFO) fs.writeFileSync(FIFO, `${line}\n`);
};

if (!FIFO) {
  console.error('SPAR_FIFO required');
  process.exit(1);
}

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: NAME, auth: 'offline', version: VERSION, hideErrors: true });
let failed = false;
const check = (label, cond, extra = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed = true;
};

bot.on('error', (e) => console.log(`bot error: ${e.message}`));

bot.once('spawn', async () => {
  bot.mcData = mcDataLoader(bot.version);
  installMovement(bot);
  await sleep(2500);

  console.log('\nNETHERITE SMITHING VERIFICATION\n');

  // Flat ground to place the table on, and the three inputs.
  const p = bot.entity.position.floored();
  cmd('gamerule sendCommandFeedback false');
  cmd(`fill ${p.x - 3} ${p.y - 1} ${p.z - 3} ${p.x + 3} ${p.y - 1} ${p.z + 3} stone`);
  cmd(`fill ${p.x - 3} ${p.y} ${p.z - 3} ${p.x + 3} ${p.y + 2} ${p.z + 3} air`);
  cmd(`clear ${NAME}`);
  cmd(`give ${NAME} netherite_upgrade_smithing_template 1`);
  cmd(`give ${NAME} netherite_ingot 1`);
  cmd(`give ${NAME} diamond_sword 1`);
  cmd(`give ${NAME} smithing_table 1`);
  await sleep(3000);

  const has = (n) => bot.inventory.items().some((i) => i.name === n);
  check('template granted', has('netherite_upgrade_smithing_template'));
  check('ingot granted', has('netherite_ingot'));
  check('diamond sword granted', has('diamond_sword'));

  const task = new Task('netherite-test');

  const table = await ensureSmithingTable(bot, task).catch((e) => {
    console.log(`  table error: ${e.message}`);
    return null;
  });
  check('smithing table placed', !!table, table ? `at ${table.position}` : 'could not place');

  const res = await upgradeNetherite(bot, task, { item: 'diamond_sword' }).catch((e) => ({ ok: false, reason: e.message }));
  check('upgrade action succeeded', res.ok, res.detail || res.reason);

  await sleep(1200);
  const gotNetherite = bot.inventory.items().some((i) => i.name === 'netherite_sword');
  check('netherite_sword now in inventory', gotNetherite,
    bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(', '));

  // Also confirm it refuses cleanly without a template, rather than hanging.
  cmd(`clear ${NAME} netherite_upgrade_smithing_template`);
  await sleep(1500);
  const noTemplate = await upgradeNetherite(bot, task, { item: 'diamond_pickaxe' }).catch((e) => ({ ok: false, reason: e.message }));
  check('fails cleanly with no template', !noTemplate.ok && /template/.test(noTemplate.reason || ''), noTemplate.reason);

  console.log(`\n  ${failed ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}\n`);
  bot.quit('done');
  setTimeout(() => process.exit(failed ? 2 : 0), 500);
});

setTimeout(() => {
  console.log('netherite test timed out');
  process.exit(3);
}, 120000);
