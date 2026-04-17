const fs = require('fs');
const path = require('path');

const PREFIX = '[nectar]';
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_FILES = 5;
const RING_BUFFER_SIZE = 2000; // last N log entries kept in memory for the UI

// Ring buffer for in-memory log access (Config > Logs tab)
const _ringBuffer = [];
let _ringIndex = 0;

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

function pushToRing(level, message) {
  const entry = { ts: new Date().toISOString(), level, message };
  if (_ringBuffer.length < RING_BUFFER_SIZE) {
    _ringBuffer.push(entry);
  } else {
    _ringBuffer[_ringIndex % RING_BUFFER_SIZE] = entry;
  }
  _ringIndex++;
}

const log = {
  info(...args) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    console.log(PREFIX, ...args);
    writeToFile('INFO', args);
    pushToRing('INFO', msg);
  },
  warn(...args) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    console.warn(PREFIX, '⚠', ...args);
    writeToFile('WARN', args);
    pushToRing('WARN', msg);
  },
  error(...args) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    console.error(PREFIX, '✗', ...args);
    writeToFile('ERROR', args);
    pushToRing('ERROR', msg);
  },
  /** Structured JSON log entry for machine parsing */
  json(level, event, data = {}) {
    const entry = { ts: new Date().toISOString(), level, event, ...data };
    const line = JSON.stringify(entry) + '\n';
    if (logStream) {
      try { logStream.write(line); currentLogSize += Buffer.byteLength(line); rotateIfNeeded(); } catch { /* ok */ }
    }
    pushToRing(level, `${event} ${JSON.stringify(data)}`);
  },
  /**
   * Get the last N log entries from memory (for the admin UI).
   * Returns entries in chronological order (oldest first).
   */
  getRecentLogs(limit = 200, levelFilter = null) {
    // Ring buffer might not be full yet
    const entries = _ringBuffer.length < RING_BUFFER_SIZE
      ? _ringBuffer.slice()
      : [..._ringBuffer.slice(_ringIndex % RING_BUFFER_SIZE), ..._ringBuffer.slice(0, _ringIndex % RING_BUFFER_SIZE)];
    let filtered = entries;
    if (levelFilter) {
      const levels = new Set(Array.isArray(levelFilter) ? levelFilter : [levelFilter]);
      filtered = entries.filter(e => levels.has(e.level));
    }
    return filtered.slice(-limit);
  },
};

module.exports = log;
