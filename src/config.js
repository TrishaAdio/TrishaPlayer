import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const bool = (v, dflt) => {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(String(v));
};
const num = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const list = (v) =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  mc: {
    host: process.env.MC_HOST || '127.0.0.1',
    port: num(process.env.MC_PORT, 25565),
    version: process.env.MC_VERSION || false, // false = auto-detect
    username: process.env.BOT_USERNAME || 'Trisha',
    auth: process.env.MC_AUTH || 'offline',
  },
  owner: process.env.OWNER || '',
  friends: list(process.env.FRIENDS),
  llm: {
    /**
     * LLM_* are the preferred names; ZEN_* are kept as aliases so existing .env files
     * keep working. The relay moved off Zen, and "ZEN_BASE_URL" pointing at something
     * that is not Zen is the kind of detail that wastes an hour later.
     */
    baseURL: process.env.LLM_BASE_URL || process.env.ZEN_BASE_URL || 'http://54.204.234.44:3000/v1',
    apiKey: process.env.LLM_API_KEY || process.env.ZEN_API_KEY || '',
    fast: process.env.MODEL_FAST || 'claude-haiku-4.5',
    smart: process.env.MODEL_SMART || 'claude-opus-5',
    // Used for the one expensive think that matters: surveying the area and building
    // a plan against it.
    planner: process.env.MODEL_PLANNER || 'claude-opus-4.8',
    chat: process.env.MODEL_CHAT || process.env.MODEL_FAST || 'claude-haiku-4.5',
    /**
     * Fallbacks are only useful if they exist. The old defaults listed gpt-5.4-mini and
     * gpt-5.5, which 404 on this relay, so a dead primary fell through to two more dead
     * names. These are all confirmed serving by `npm run probe`.
     *
     * claude-opus-4.5 and claude-sonnet-4 are deliberately excluded: both refuse the
     * persona outright with "I'm a coding assistant for the Kiro CLI".
     */
    fastFallbacks: list(process.env.MODEL_FAST_FALLBACKS).length
      ? list(process.env.MODEL_FAST_FALLBACKS)
      : ['gpt-5.6-terra', 'gpt-5.6-luna', 'qwen3-coder-next'],
    smartFallbacks: list(process.env.MODEL_SMART_FALLBACKS).length
      ? list(process.env.MODEL_SMART_FALLBACKS)
      : ['claude-sonnet-5', 'claude-opus-4.8', 'gpt-5.6-sol'],
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 20000),
  },
  brain: {
    thinkIntervalMs: num(process.env.THINK_INTERVAL_MS, 6000),
    autonomy: bool(process.env.AUTONOMY, true),
  },
  ladder: {
    onSpawn: bool(process.env.LADDER_ON_SPAWN, true),
    ironY: num(process.env.IRON_Y, 16),
    /**
     * How far to look for ore before resorting to blind tunnelling.
     *
     * The server streams her every block in the loaded chunks, so searching a wide radius
     * and walking to a real seam is both much faster and much safer than digging on spec.
     * A whole live run came back with zero ore from hundreds of blocks of straight tunnel.
     */
    oreScan: num(process.env.ORE_SCAN_RADIUS, 64),
    diamondY: num(process.env.DIAMOND_Y, -54),
    homeInvFull: num(process.env.HOME_INV_FULL, 0.85),
    homeHp: num(process.env.HOME_HP, 8),
  },
  combat: {
    // 'self_defence' = fight back + defend owner only. 'free' = duel anyone.
    pvpMode: process.env.PVP_MODE || 'self_defence',
  },
  viewer: {
    // Set VIEWER_PORT to serve a live browser view of what she is doing. Off by default.
    port: num(process.env.VIEWER_PORT, 0),
    firstPerson: bool(process.env.VIEWER_FIRST_PERSON, false),
  },
  verbose: bool(process.env.VERBOSE, true),
  memoryDir: path.join(ROOT, 'memory'),
};

export function assertConfig() {
  const problems = [];
  if (!config.llm.apiKey || config.llm.apiKey.startsWith('sk-replace')) {
    // Name both, because the variable was renamed and the old message sent me looking
    // for a key that was present under the new name.
    problems.push('LLM_API_KEY (or legacy ZEN_API_KEY) is not set in .env — the brain cannot start.');
  }
  if (!config.owner) {
    problems.push('OWNER is not set in .env — Trisha will not know who to obey.');
  }
  return problems;
}
