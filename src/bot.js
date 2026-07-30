/**
 * Assembly. Body, reflexes, combat, skills, brain — wired in that order,
 * because each layer depends on the one below it.
 */
import mineflayer from 'mineflayer';
import mcDataLoader from 'minecraft-data';
import { config } from './config.js';
import { log } from './util/log.js';
import { loadMemory, saveMemory, mem } from './world/memory.js';
import { Reflex } from './reflex/survival.js';
import { installGear, equipBest } from './reflex/gear.js';
import { installMovement } from './skills/move.js';
import { Targeting } from './combat/targeting.js';
import { CombatEngine } from './combat/engine.js';
import { Executor } from './actions.js';
import { Brain } from './llm/brain.js';
import { installReporter, recordDeath, milestone } from './util/report.js';

export function createTrisha() {
  log.info(`connecting to ${config.mc.host}:${config.mc.port} as ${config.mc.username} (${config.mc.auth})`);

  const bot = mineflayer.createBot({
    host: config.mc.host,
    port: config.mc.port,
    username: config.mc.username,
    auth: config.mc.auth,
    version: config.mc.version || false,
    hideErrors: false,
    checkTimeoutInterval: 60000,
    respawn: true,
  });

  bot.trisha = { ready: false };

  bot.once('spawn', () => {
    try {
      setup(bot);
    } catch (err) {
      log.error(`setup failed: ${err.stack || err.message}`);
    }
  });

  bot.on('error', (err) => log.error(`bot error: ${err.message}`));
  bot.on('kicked', (reason) => log.warn(`kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
  bot.on('end', (reason) => log.warn(`disconnected: ${reason || 'unknown'}`));

  return bot;
}

function setup(bot) {
  bot.mcData = mcDataLoader(bot.version);
  log.info(`spawned in — server ${bot.version}, ${Object.keys(bot.players).length} players online`);

  loadMemory();

  // 1. Body: pathfinding with lava-avoidance and fall safety.
  installMovement(bot);

  // 2. Reflexes: survival + the whole clutch chain. Never waits on a model.
  const reflex = new Reflex(bot).install();
  installGear(bot);

  // 3. Combat.
  const targeting = new Targeting(bot);
  const combat = new CombatEngine(bot, reflex, targeting);

  // 4. Skills executor: one cancellable action at a time.
  const flags = { returnedHome: false };
  const executor = new Executor({ bot, reflex, combat, targeting, flags });

  // 5. Brain.
  const brain = new Brain({ bot, reflex, combat, targeting, executor, flags });

  bot.trisha = { ready: true, reflex, targeting, combat, executor, brain, flags };

  // ── event wiring ──────────────────────────────────────────
  bot.on('chat', (username, message) => {
    brain.onChat(username, message).catch((err) => log.warn(`chat handling: ${err.message}`));
  });

  bot.on('whisper', (username, message) => {
    brain.onChat(username, message).catch(() => {});
  });

  bot.on('death', () => {
    recordDeath(brain.guessDeathCause());
    brain.onDeath();
  });

  bot.on('spawn', () => {
    brain.onSpawn();
    setTimeout(() => equipBest(bot).catch(() => {}), 1500);
  });

  bot.on('playerJoined', (player) => {
    if (player.username === config.owner) {
      setTimeout(() => brain.say('youre back~'), 2000);
    }
  });

  // She reacts when her player takes a hit, without being asked.
  /**
   * TAKING DAMAGE MUST INTERRUPT WHATEVER SHE IS DOING.
   *
   * The brain's step loop returns early while an action runs, so a long job like
   * mining a vein left nothing watching her health. She was killed by a player
   * mid-mine without ever reacting. A big hit now forces an immediate decision:
   * fight back if the attacker is fair game, otherwise disengage and heal.
   */
  reflex.on('bigHit', (amount) => {
    if (bot.health == null) return;
    const inCombat = ['attack', 'duel', 'defend', 'retreat', 'hunt', 'kite'].includes(executor.currentName);
    if (inCombat) return;

    const threat = brain.nearestThreat();
    if (threat) {
      log.warn(`took ${amount} damage from ${threat.username || threat.name} — fighting back`);
      brain.acceptOrder('(under attack)', [{ name: 'attack', args: { target: threat.username || threat.name } }], true);
    } else if (bot.health <= 10) {
      log.warn(`took ${amount} damage from something unseen at ${Math.round(bot.health)} hp — breaking off`);
      brain.acceptOrder('(hurt by something unseen)', [{ name: 'retreat', args: {} }], true);
    }
  });

  reflex.on('ownerHurt', () => {
    if (!executor.busy || executor.currentName !== 'attack') {
      const threat = targeting.pick({ maxDistance: 14 });
      if (threat) {
        brain.acceptOrder('(owner under attack)', [{ name: 'attack', args: { target: threat.username || threat.name } }], true);
      }
    }
  });

  // Rate-limited: a recurring hazard like swimming in an ocean used to print a
  // panic/recovered pair every second and bury everything else in the log.
  let lastPanicLog = 0;
  reflex.on('panic', (reason) => {
    if (Date.now() - lastPanicLog < 15000) return;
    lastPanicLog = Date.now();
    log.warn(`panic: ${reason}`);
  });
  reflex.on('clutch', (name) => {
    if (/totem|stash|wall off/.test(name)) brain.say(name === 'loot stash' ? 'stashing my stuff!' : 'that was close');
  });

  reflex.on('starving', () => {
    if (!executor.busy) brain.acceptOrder('(starving)', [{ name: 'getFood', args: { urgent: true } }], true);
  });

  // Periodic heartbeat so you can see she is alive, what rung she is on, and whether
  // the numbers her rung predicates depend on are actually moving.
  setInterval(() => {
    if (!bot.entity) return;
    log.info(brain.progressLine());
    saveMemory();
  }, 20000);

  /**
   * Evidence that survives being killed. A validation run is nearly always stopped
   * rather than allowed to finish, and without this the whole result dies with the
   * process — which has already happened several times.
   */
  installReporter(bot, brain, executor, { everyMs: 10000 });

  // 6. Go.
  setTimeout(() => {
    equipBest(bot).catch(() => {});
    brain.start();
    brain.say(`hi ${config.owner}~ im here`);
  }, 2500);
}
