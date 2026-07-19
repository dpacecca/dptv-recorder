const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'guide.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,          -- XC stream_id
    name TEXT NOT NULL,
    logo TEXT,
    category_id TEXT,
    epg_channel_id TEXT,          -- links to programs.epg_channel_id
    stream_num INTEGER,
    FOREIGN KEY (category_id) REFERENCES categories(id)
  );
  CREATE INDEX IF NOT EXISTS idx_channels_category ON channels(category_id);
  CREATE INDEX IF NOT EXISTS idx_channels_epg ON channels(epg_channel_id);

  CREATE TABLE IF NOT EXISTS programs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epg_channel_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    start INTEGER NOT NULL,   -- epoch ms
    stop INTEGER NOT NULL     -- epoch ms
  );
  CREATE INDEX IF NOT EXISTS idx_programs_lookup ON programs(epg_channel_id, start, stop);

  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    channel_name TEXT NOT NULL,
    program_title TEXT NOT NULL,
    program_start INTEGER NOT NULL,  -- original EPG start/stop, used to match the button state
    program_stop INTEGER NOT NULL,
    rec_start INTEGER NOT NULL,      -- actual recording window (padding applied)
    rec_end INTEGER NOT NULL,
    status TEXT NOT NULL,            -- scheduled | recording | completed | failed | cancelled
    filename TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_recordings_program ON recordings(channel_id, program_start, program_stop);
  CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status, rec_start);
`);

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

module.exports = { db, getSetting, setSetting, getAllSettings, DB_PATH };
