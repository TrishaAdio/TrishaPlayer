import { config } from '../config.js';

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  pink: '\x1b[95m',
  cyan: '\x1b[96m',
  green: '\x1b[92m',
  yellow: '\x1b[93m',
  red: '\x1b[91m',
  blue: '\x1b[94m',
};

const stamp = () => new Date().toTimeString().slice(0, 8);

const emit = (color, tag, msg) => console.log(`${C.dim}${stamp()}${C.reset} ${color}${tag}${C.reset} ${msg}`);

export const log = {
  info: (m) => emit(C.cyan, 'info ', m),
  brain: (m) => emit(C.pink, 'brain', m),
  act: (m) => emit(C.blue, 'act  ', m),
  reflex: (m) => emit(C.green, 'reflx', m),
  chat: (m) => emit(C.pink, 'chat ', m),
  warn: (m) => emit(C.yellow, 'warn ', m),
  error: (m) => emit(C.red, 'error', m),
  debug: (m) => {
    if (config.verbose) emit(C.dim, 'dbg  ', m);
  },
};
