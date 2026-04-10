const fs = require('fs');
const path = require('path');

const PREFIX = '[nectar]';
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 5;

let logStream = null;
let currentLogSize = 0;

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function getLogPath(index = 0) {
  return path.join(LOG_DIR, index === 0 ? 'nectar.log' : `nectar.${index}.log`);
}

function rotateIfNeeded() {
  if (currentLogSize < MAX_LOG_SIZE) return;
  if (logStream) { logStream.end(); logStream = null; }
  // Rotate files: nectar.4.log → delete, nectar.3.log → nectar.4.log, etc.
  for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
    const src = getLogPath(i - 1);
    const dst = getLogPath(i);
    try { if (fs.existsSync(src)) fs.renameSync(src, dst); } catch { /* ok */ }
  }
  currentLogSize = 0;
  openStream();
}

function openStream() {
  ensureLogDir();
  const p = getLogPath(0);
  try { currentLogSize = fs.existsSync(p) ? fs.statSync(p).size : 0; } catch { currentLogSize = 0; }
  logStream = fs.createWriteStream(p, { flags: 'a' });
}

function writeToFile(level, args) {
  if (!logStream) openStream();
  const ts = new Date().toISOString();
  const msg = `${ts} [${level}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`;
  try {
    logStream.write(msg);
    currentLogSize += Buffer.byteLength(msg);
    rotateIfNeeded();
  } catch { /* don't crash on log failure */ }
}

const log = {
  info(...args) {
    console.log(PREFIX, ...args);
    writeToFile('INFO', args);
  },
  warn(...args) {
    console.warn(PREFIX, '⚠', ...args);
    writeToFile('WARN', args);
  },
  error(...args) {
    console.error(PREFIX, '✗', ...args);
    writeToFile('ERROR', args);
  },
  /** Structured JSON log entry for machine parsing */
  json(level, event, data = {}) {
    const entry = { ts: new Date().toISOString(), level, event, ...data };
    const line = JSON.stringify(entry) + '\n';
    if (logStream) {
      try { logStream.write(line); currentLogSize += Buffer.byteLength(line); rotateIfNeeded(); } catch { /* ok */ }
    }
  },
};

module.exports = log;
