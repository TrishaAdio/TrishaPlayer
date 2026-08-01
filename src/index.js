/**
 * Boot. Keeps her online: reconnects with backoff, survives crashes, saves memory
 * on the way out so nothing she learned is lost.
 */
import { config, assertConfig } from './config.js';
import { log } from './util/log.js';
import { saveMemory } from './world/memory.js';
import { createTrisha } from './bot.js';

const problems = assertConfig();
for (const p of problems) log.warn(p);
if (problems.some((p) => p.includes("API_KEY"))) {
  log.error('no API key — she would have no brain. put ZEN_API_KEY in .env');
  process.exit(1);
}

let bot = null;
let attempts = 0;
let shuttingDown = false;

function connect() {
  if (shuttingDown) return;
  attempts++;
  try {
    bot = createTrisha();
  } catch (err) {
    log.error(`could not create bot: ${err.message}`);
    return scheduleReconnect();
  }

  bot.once('spawn', () => {
    attempts = 0;
  });
  bot.once('end', () => {
    if (!shuttingDown) scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (shuttingDown) return;
  const delay = Math.min(60000, 4000 * Math.pow(1.6, Math.min(attempts, 8)));
  log.warn(`reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempts + 1})`);
  saveMemory(true);
  setTimeout(connect, delay);
}

process.on('uncaughtException', (err) => {
  log.error(`uncaught: ${err.stack || err.message}`);
  saveMemory(true);
});
process.on('unhandledRejection', (err) => {
  log.warn(`unhandled rejection: ${err?.message || err}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    shuttingDown = true;
    log.info('shutting down, saving memory');
    saveMemory(true);
    try {
      bot?.quit?.('bye');
    } catch {}
    setTimeout(() => process.exit(0), 400);
  });
}

log.info(`Trisha starting — owner ${config.owner}, brain ${config.llm.fast} / ${config.llm.smart}`);
connect();
