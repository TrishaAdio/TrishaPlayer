/**
 * PRE-FLIGHT — checks a real server before Trisha tries to join it.
 *
 * Run this first against any new server. It answers, in order, the questions that
 * actually stop a bot from connecting, and it does so without joining the world:
 *
 *   1. is the port reachable at all from here?
 *   2. what version does the server report, and can mineflayer speak it?
 *   3. is it offline-mode (cracked)? online-mode servers will reject her.
 *   4. is the name she wants already taken?
 *   5. how bad is the latency, since combat timing depends on it?
 *
 * A failure here is far cheaper to read than a mysterious disconnect mid-join.
 *
 * Usage: node scripts/connect-test.js --host 1.2.3.4 --port 25565
 */
import net from 'node:net';
import mc from 'minecraft-protocol';
import mcDataLoader from 'minecraft-data';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const HOST = arg('host', process.env.MC_HOST || '127.0.0.1');
const PORT = Number(arg('port', process.env.MC_PORT || 25565));
const WANT_NAME = arg('username', process.env.BOT_USERNAME || 'Trisha');

const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
const note = (m) => console.log(`        ${m}`);

/** Raw TCP reachability, so we can tell "blocked" apart from "wrong protocol". */
function tcpProbe(host, port, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish({ reachable: true, ms: Date.now() - started }));
    sock.once('timeout', () => finish({ reachable: false, reason: 'timed out — port filtered or server down' }));
    sock.once('error', (err) => finish({ reachable: false, reason: err.code || err.message }));
    sock.connect(port, host);
  });
}

(async () => {
  console.log(`\nPRE-FLIGHT: ${HOST}:${PORT}\n`);

  // ── 1. TCP ────────────────────────────────────────────────
  const tcp = await tcpProbe(HOST, PORT);
  if (!tcp.reachable) {
    bad(`cannot open a TCP connection (${tcp.reason})`);
    note('either the port is closed, the host is wrong, or outbound traffic on this');
    note('port is blocked from this sandbox. nothing else can be tested.');
    process.exit(1);
  }
  ok(`TCP reachable in ${tcp.ms}ms`);

  // ── 2. server list ping ───────────────────────────────────
  let info;
  try {
    info = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ping timed out after 12s')), 12000);
      mc.ping({ host: HOST, port: PORT }, (err, result) => {
        clearTimeout(t);
        if (err) reject(err);
        else resolve(result);
      });
    });
  } catch (err) {
    bad(`server list ping failed: ${err.message}`);
    note('the port answers but does not speak the Minecraft protocol —');
    note('check that this is the game port and not a web/query port.');
    process.exit(2);
  }

  const versionName = info.version?.name ?? 'unknown';
  const protocol = info.version?.protocol ?? '?';
  ok(`server responded: "${String(versionName).replace(/\u00a7./g, '')}" (protocol ${protocol})`);
  if (info.latency != null) note(`ping latency: ${info.latency}ms`);

  const motd = typeof info.description === 'string'
    ? info.description
    : info.description?.text || JSON.stringify(info.description || '').slice(0, 120);
  if (motd) note(`motd: ${String(motd).replace(/\u00a7./g, '').replace(/\s+/g, ' ').trim().slice(0, 90)}`);

  const online = info.players?.online ?? 0;
  const max = info.players?.max ?? '?';
  ok(`players online: ${online}/${max}`);

  const sample = info.players?.sample?.map((p) => p.name) || [];
  if (sample.length) {
    note(`visible names: ${sample.join(', ')}`);
    if (sample.some((n) => n.toLowerCase() === WANT_NAME.toLowerCase())) {
      bad(`"${WANT_NAME}" is ALREADY on the server — she cannot join under that name`);
      note('change BOT_USERNAME in .env, or disconnect the existing session.');
    } else {
      ok(`"${WANT_NAME}" is free to use`);
    }
  }

  // ── 3. can mineflayer speak this version? ─────────────────
  const clean = String(versionName).replace(/[^0-9.]/g, '').replace(/\.+$/, '');
  const guess = clean.match(/1\.\d+(\.\d+)?/)?.[0];
  if (guess) {
    let supported = false;
    try {
      supported = !!mcDataLoader(guess);
    } catch {
      supported = false;
    }
    if (supported) ok(`minecraft-data has protocol data for ${guess}`);
    else {
      bad(`no protocol data for "${guess}"`);
      note('pin MC_VERSION in .env to the nearest supported release, or route her');
      note('through ViaProxy if the server is newer than mineflayer supports.');
    }
  } else {
    note(`could not parse a version number from "${versionName}" — set MC_VERSION manually`);
  }

  // ── 4. online-mode detection ──────────────────────────────
  // An offline-mode (cracked) server accepts a login with no session check. An
  // online-mode server rejects it, and the rejection is quick and unambiguous.
  console.log('\n  checking whether the server is offline-mode (cracked)...');
  const probeName = `probe${Math.floor(Math.random() * 9000 + 1000)}`;
  const verdict = await new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let client;
    try {
      client = mc.createClient({
        host: HOST,
        port: PORT,
        username: probeName,
        auth: 'offline',
        version: guess || false,
challenge: false,
      });
    } catch (err) {
      return done({ mode: 'error', reason: err.message });
    }
    const timer = setTimeout(() => {
      try {
        client.end();
      } catch {}
      done({ mode: 'timeout' });
    }, 15000);

    client.on('login', () => {
      clearTimeout(timer);
      try {
        client.end();
      } catch {}
      done({ mode: 'offline' });
    });
    client.on('disconnect', (packet) => {
      clearTimeout(timer);
      done({ mode: 'kicked', reason: JSON.stringify(packet?.reason || '').slice(0, 200) });
    });
    client.on('kick_disconnect', (packet) => {
      clearTimeout(timer);
      done({ mode: 'kicked', reason: JSON.stringify(packet?.reason || '').slice(0, 200) });
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      done({ mode: 'error', reason: err.message });
    });
  });

  if (verdict.mode === 'offline') {
    ok('server is OFFLINE-MODE — she can join');
  } else if (verdict.mode === 'kicked') {
    const r = String(verdict.reason || '').toLowerCase();
    if (/whitelist/.test(r)) bad(`whitelisted — add "${WANT_NAME}" to the whitelist`);
    else if (/authenticat|premium|mojang|online.?mode|not signed/.test(r)) bad('server is ONLINE-MODE — a cracked bot cannot join');
    else if (/ban/.test(r)) bad(`that address appears banned: ${verdict.reason}`);
    else bad(`login rejected: ${verdict.reason}`);
  } else if (verdict.mode === 'timeout') {
    note('login neither completed nor was rejected — possibly a proxy or anti-bot plugin');
  } else {
    bad(`login probe error: ${verdict.reason}`);
  }

  console.log('\n  pre-flight done. if everything above passed, she is clear to join.\n');
  process.exit(0);
})();
