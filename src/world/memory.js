import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../util/log.js';

const FILE = path.join(config.memoryDir, 'trisha.json');

const DEFAULTS = {
  base: null, // {x,y,z,label}
  bed: null,
  chests: [], // {x,y,z,note}
  waypoints: {}, // name -> {x,y,z}
  deaths: [], // {reason, pos, time, lesson}
  lessons: [], // short strings the brain wrote for itself
  ores: {}, // 'diamond_ore' -> [{x,y,z}]
  stats: { deaths: 0, kills: 0, playerKills: 0, blocksMined: 0, itemsCrafted: 0, sessions: 0 },
  notes: [],
};

let state = structuredClone(DEFAULTS);
let dirty = false;

export function loadMemory() {
  try {
    fs.mkdirSync(config.memoryDir, { recursive: true });
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      state = { ...structuredClone(DEFAULTS), ...raw };
      state.stats = { ...DEFAULTS.stats, ...(raw.stats || {}) };
      log.info(`memory loaded (${state.stats.deaths} deaths, ${state.chests.length} chests known)`);
    } else {
      log.info('fresh memory');
    }
  } catch (err) {
    log.warn(`memory load failed, starting fresh: ${err.message}`);
    state = structuredClone(DEFAULTS);
  }
  state.stats.sessions++;
  dirty = true;
  return state;
}

export function saveMemory(force = false) {
  if (!dirty && !force) return;
  try {
    fs.mkdirSync(config.memoryDir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    dirty = false;
  } catch (err) {
    log.warn(`memory save failed: ${err.message}`);
  }
}

export const mem = {
  get all() {
    return state;
  },
  get stats() {
    return state.stats;
  },
  set(key, value) {
    state[key] = value;
    dirty = true;
  },
  bump(statKey, by = 1) {
    state.stats[statKey] = (state.stats[statKey] || 0) + by;
    dirty = true;
  },
  setBase(pos, label = 'home') {
    state.base = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), label };
    dirty = true;
  },
  setBed(pos) {
    state.bed = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
    dirty = true;
  },
  addChest(pos, note = '') {
    const p = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), note };
    if (!state.chests.some((c) => c.x === p.x && c.y === p.y && c.z === p.z)) {
      state.chests.push(p);
      dirty = true;
    }
  },
  addWaypoint(name, pos) {
    state.waypoints[name] = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
    dirty = true;
  },
  rememberOre(name, pos) {
    const arr = (state.ores[name] = state.ores[name] || []);
    const p = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
    if (!arr.some((o) => o.x === p.x && o.y === p.y && o.z === p.z)) {
      arr.push(p);
      if (arr.length > 40) arr.shift();
      dirty = true;
    }
  },
  recordDeath(reason, pos) {
    state.deaths.unshift({
      reason,
      pos: pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null,
      time: new Date().toISOString(),
    });
    state.deaths = state.deaths.slice(0, 15);
    state.stats.deaths++;
    dirty = true;
  },
  addLesson(text) {
    const t = String(text).trim().slice(0, 160);
    if (!t || state.lessons.includes(t)) return;
    state.lessons.unshift(t);
    state.lessons = state.lessons.slice(0, 25);
    dirty = true;
  },
  note(text) {
    state.notes.unshift({ t: new Date().toISOString(), text: String(text).slice(0, 200) });
    state.notes = state.notes.slice(0, 30);
    dirty = true;
  },
  /** Compact form handed to the LLM every tick. */
  summary() {
    const pos = (p) => (p ? `${p.x},${p.y},${p.z}` : 'unknown');
    const lines = [];
    if (state.base) lines.push(`base: ${pos(state.base)}`);
    if (state.bed) lines.push(`bed: ${pos(state.bed)}`);
    if (state.chests.length) lines.push(`chests: ${state.chests.slice(0, 5).map(pos).join(' | ')}`);
    const wp = Object.entries(state.waypoints).slice(0, 6);
    if (wp.length) lines.push(`waypoints: ${wp.map(([n, p]) => `${n}@${pos(p)}`).join(' | ')}`);
    if (state.lessons.length) lines.push(`lessons: ${state.lessons.slice(0, 6).join(' ; ')}`);
    if (state.deaths.length) {
      const d = state.deaths[0];
      lines.push(`last death: ${d.reason} at ${pos(d.pos)}`);
    }
    lines.push(
      `record: ${state.stats.deaths} deaths, ${state.stats.kills} mob kills, ${state.stats.playerKills} player kills`,
    );
    return lines.join('\n');
  },
};

setInterval(() => saveMemory(), 20000).unref?.();
