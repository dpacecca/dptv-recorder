const cron = require('node-cron');
const { db, getSetting, setSetting } = require('./db');
const xc = require('./xcClient');
const { parseXmltv } = require('./xmltv');

let cronTask = null;
let syncState = { running: false, phase: null, error: null, startedAt: null, finishedAt: null };

function getSyncState() {
  return { ...syncState, lastSyncAt: getSetting('last_sync_at', null) };
}

function requireCreds() {
  const host = getSetting('xc_host');
  const username = getSetting('xc_username');
  const password = getSetting('xc_password');
  if (!host || !username || !password) {
    throw new Error('XC server is not configured yet. Add your host, username and password in Settings.');
  }
  return { host, username, password };
}

async function performSync() {
  if (syncState.running) return syncState;
  syncState = { running: true, phase: 'starting', error: null, startedAt: Date.now(), finishedAt: null };

  try {
    const { host, username, password } = requireCreds();

    syncState.phase = 'categories';
    const categories = await xc.getLiveCategories(host, username, password);

    syncState.phase = 'channels';
    const streams = await xc.getLiveStreams(host, username, password);

    syncState.phase = 'epg';
    const xmltvText = await xc.fetchXmltv(host, username, password);
    const { programmes } = parseXmltv(xmltvText);

    syncState.phase = 'saving';
    const now = Date.now();
    const windowStart = now - 24 * 60 * 60 * 1000;      // keep a day of history
    const windowEnd = now + 8 * 24 * 60 * 60 * 1000;    // keep up to 8 days ahead

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM categories').run();
      const insCat = db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)');
      categories.forEach((c, i) => insCat.run(String(c.category_id), c.category_name, i));

      db.prepare('DELETE FROM channels').run();
      const insChan = db.prepare(`
        INSERT INTO channels (id, name, logo, category_id, epg_channel_id, stream_num)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      streams.forEach((s) => {
        insChan.run(
          String(s.stream_id),
          s.name,
          s.stream_icon || null,
          String(s.category_id),
          s.epg_channel_id || null,
          s.num || null
        );
      });

      db.prepare('DELETE FROM programs').run(); // full refresh each sync keeps EPG consistent
      const insProg = db.prepare(`
        INSERT INTO programs (epg_channel_id, title, description, start, stop)
        VALUES (?, ?, ?, ?, ?)
      `);
      programmes.forEach((p) => {
        if (p.start < windowStart || p.start > windowEnd) return;
        insProg.run(p.channel, p.title, p.description, p.start, p.stop);
      });
    });
    tx();

    setSetting('last_sync_at', Date.now());
    syncState.phase = 'done';
  } catch (err) {
    syncState.error = err.message;
    syncState.phase = 'error';
    throw err;
  } finally {
    syncState.running = false;
    syncState.finishedAt = Date.now();
  }

  return syncState;
}

function scheduleAutoSync(hours) {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
  const h = Number(hours) || 0;
  setSetting('auto_sync_hours', h);
  if (h > 0) {
    // node-cron supports step values in the hour field, e.g. "0 */4 * * *"
    const expr = `0 */${h} * * *`;
    cronTask = cron.schedule(expr, () => {
      performSync().catch((err) => console.error('[auto-sync] failed:', err.message));
    });
  }
}

function initScheduler() {
  const hours = Number(getSetting('auto_sync_hours', 4)) || 0;
  scheduleAutoSync(hours);
}

module.exports = { performSync, scheduleAutoSync, initScheduler, getSyncState };
