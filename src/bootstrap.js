/**
 * Shared bootstrap for both web-server and sync-worker.
 * Loads .env, config, opens SQLite DB, runs migrations.
 */
const path = require('path');
const fs = require('fs');
const log = require('./core/log');

// Prevent unhandled errors from crashing the process
process.on('uncaughtException', (err) => {
  log.error(`[uncaught] ${err.message}`);
  if (err.stack) log.error(err.stack);
});

// ── Load .env ─────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const key = trimmed.substring(0, eq);
      let value = trimmed.substring(eq + 1);
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

// ── Load config ───────────────────────────────────────────
const configPath = path.join(__dirname, '..', 'nectar.config.js');
if (!fs.existsSync(configPath)) {
  log.error('Missing nectar.config.js');
  process.exit(1);
}
const config = require(configPath);

// ── Open SQLite DB + migrate ──────────────────────────────
const { getDb } = require('./core/db');
const { migrateFromJson } = require('./core/migrate');
const db = getDb();
try {
  const migrated = migrateFromJson(db, path.join(__dirname, '..'));
  const totalMoved = Object.values(migrated).reduce((a, b) => a + b, 0);
  if (totalMoved === 0) {
    log.info('DB migration: up to date (no JSON records to import)');
  }
} catch (err) {
  log.error(`DB migration failed: ${err.message}`);
  if (err.stack) log.error(err.stack);
}

module.exports = { config, db, log };
