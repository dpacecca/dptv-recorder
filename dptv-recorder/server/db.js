const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'guide.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
// Explicitly off: some SQLite builds default this to ON, which would reject
// channels whose category_id doesn't (yet, or ever) match a known category -
// common with providers/aggregators that have inconsistent category data.
// We handle orphaned category_ids ourselves in sync.js instead of relying on
// the database to enforce it.
db.pragma('foreign_keys = OFF');

// ---- migration: old single-tenant schema -> per-user schema ----
// Multi-user support requires every table to be scoped by user_id. There's
// no sane way to guess which existing user "owns" old global data, so if we
// detect the pre-multi-user schema, we drop and rebuild those tables rather
// than leave a half-migrated database around. Recordings already on disk
// are left alone (only the DB rows referencing them are lost) - this is a
// one-time transition, not something that happens on every startup.
(function migrateToMultiUser() {
  const settingsInfo = db.prepare("PRAGMA table_info(settings)").all();
  const hasOldSchema = settingsInfo.length > 0 && !settingsInfo.some((c) => c.name === 'user_id');
  if (!hasOldSchema) return;
  console.warn('[db] pre-multi-user database detected - resetting settings/categories/channels/programs/recordings/epg_sources for the new per-user schema. Recording files on disk are not deleted, only their DB records.');
  db.exec(`
    DROP TABLE IF EXISTS settings;
    DROP TABLE IF EXISTS categories;
    DROP TABLE IF EXISTS channels;
    DROP TABLE IF EXISTS programs;
    DROP TABLE IF EXISTS recordings;
    DROP TABLE IF EXISTS epg_sources;
  `);
})();

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT,             -- nullable: an OIDC-only account may never set a local password
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    oidc_subject TEXT UNIQUE,       -- Authentik's "sub" claim, once linked
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  -- system-wide settings (OIDC config etc) - not scoped to a user
  CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS categories (
    user_id INTEGER NOT NULL,
    id TEXT NOT NULL,             -- XC category_id
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    PRIMARY KEY (user_id, id)
  );

  CREATE TABLE IF NOT EXISTS channels (
    user_id INTEGER NOT NULL,
    id TEXT NOT NULL,             -- XC stream_id
    name TEXT NOT NULL,
    logo TEXT,
    category_id TEXT,
    epg_channel_id TEXT,          -- links to programs.epg_channel_id
    stream_num INTEGER,
    PRIMARY KEY (user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_channels_category ON channels(user_id, category_id);
  CREATE INDEX IF NOT EXISTS idx_channels_epg ON channels(user_id, epg_channel_id);

  CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    epg_channel_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    start INTEGER NOT NULL,   -- epoch ms
    stop INTEGER NOT NULL     -- epoch ms
  );
  CREATE INDEX IF NOT EXISTS idx_programs_lookup ON programs(user_id, epg_channel_id, start, stop);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_programs_unique ON programs(user_id, epg_channel_id, start, stop);

  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    program_title TEXT NOT NULL,
    program_start INTEGER NOT NULL,
    program_stop INTEGER NOT NULL,
    rec_start INTEGER NOT NULL,
    rec_end INTEGER NOT NULL,
    status TEXT NOT NULL,
    filename TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recordings_program ON recordings(user_id, channel_id, program_start, program_stop);
  CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(user_id, status, rec_start);

  CREATE TABLE IF NOT EXISTS epg_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

function getSetting(userId, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE user_id = ? AND key = ?').get(userId, key);
  return row ? row.value : fallback;
}

function setSetting(userId, key, value) {
  db.prepare(`
    INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).run(userId, key, String(value));
}

function getSystemSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSystemSetting(key, value) {
  db.prepare(`
    INSERT INTO system_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

module.exports = { db, getSetting, setSetting, getSystemSetting, setSystemSetting, DB_PATH };
