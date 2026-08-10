const cron = require('node-cron');
const { db, getSetting, setSetting } = require('./db');
const xc = require('./xcClient');
const { parseXmltv } = require('./xmltv');

let cronTask = null;
let syncState = { running: false, phase: null, error: null, startedAt: null, finishedAt: null, skipped: null };

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
  if (syncState.running) {
    console.log('[sync] already running, ignoring duplicate trigger');
    return syncState;
  }
  syncState = { running: true, phase: 'starting', error: null, startedAt: Date.now(), finishedAt: null, skipped: null };
  console.log('[sync] starting');

  try {
    const { host, username, password } = requireCreds();

    syncState.phase = 'categories';
    console.log('[sync] fetching categories from', host);
    const categories = await xc.getLiveCategories(host, username, password);
    console.log(`[sync] got ${categories.length} categories`);

    syncState.phase = 'channels';
    const streams = await xc.getLiveStreams(host, username, password);
    console.log(`[sync] got ${streams.length} channels`);

    syncState.phase = 'epg';
    const activeEpgSourceId = getSetting('active_epg_source_id', '');
    let xmltvText;
    if (activeEpgSourceId) {
      const source = db.prepare('SELECT * FROM epg_sources WHERE id = ?').get(activeEpgSourceId);
      if (!source) {
        throw new Error(`Selected EPG source (id ${activeEpgSourceId}) no longer exists - pick another one in Settings.`);
      }
      console.log(`[sync] fetching EPG from custom source "${source.name}": ${source.url}`);
      xmltvText = await xc.fetchGenericXmltv(source.url);
    } else {
      console.log('[sync] fetching EPG from XC server xmltv.php');
      xmltvText = await xc.fetchXmltv(host, username, password);
    }
    console.log(`[sync] fetched xmltv (${xmltvText.length} bytes)`);
    const { programmes } = parseXmltv(xmltvText);
    console.log(`[sync] parsed ${programmes.length} programmes from xmltv`);

    syncState.phase = 'saving';
    const now = Date.now();
    const windowStart = now - 24 * 60 * 60 * 1000;      // keep a day of history
    const windowEnd = now + 8 * 24 * 60 * 60 * 1000;    // keep up to 8 days ahead

    const skipped = { categories: 0, channels: 0, programmes: 0 };

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM categories').run();
      const insCat = db.prepare('INSERT INTO categories (id, name, sort_order) VALUES (?, ?, ?)');
      const knownCategoryIds = new Set();
      categories.forEach((c, i) => {
        if (c.category_id === undefined || c.category_id === null) { skipped.categories++; return; }
        const id = String(c.category_id);
        try {
          insCat.run(id, c.category_name != null ? String(c.category_name) : '(Unnamed)', i);
          knownCategoryIds.add(id);
        } catch (err) {
          skipped.categories++;
          console.warn('[sync] skipped a malformed category:', err.message, JSON.stringify(c).slice(0, 200));
        }
      });

      // Some providers/aggregators list channels under a category_id that
      // never actually appears in get_live_categories. Rather than drop
      // those channels (they'd become invisible - not shown under any
      // category), give them a synthetic "Uncategorized" bucket per missing
      // id, so they still show up somewhere.
      let nextSortOrder = categories.length;
      const orphanedCategoryIds = new Set();
      streams.forEach((s) => {
        const id = s.category_id != null ? String(s.category_id) : '';
        if (id && !knownCategoryIds.has(id)) orphanedCategoryIds.add(id);
      });
      orphanedCategoryIds.forEach((id) => {
        insCat.run(id, `Uncategorized (${id})`, nextSortOrder++);
        knownCategoryIds.add(id);
      });
      if (orphanedCategoryIds.size > 0) {
        console.warn(`[sync] ${orphanedCategoryIds.size} category id(s) referenced by channels weren't in get_live_categories - created placeholder categories for them so those channels stay visible`);
      }

      db.prepare('DELETE FROM channels').run();
      const insChan = db.prepare(`
        INSERT INTO channels (id, name, logo, category_id, epg_channel_id, stream_num)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      streams.forEach((s) => {
        if (s.stream_id === undefined || s.stream_id === null) { skipped.channels++; return; }
        try {
          insChan.run(
            String(s.stream_id),
            s.name != null ? String(s.name) : `Channel ${s.stream_id}`,
            s.stream_icon || null,
            s.category_id != null ? String(s.category_id) : '',
            s.epg_channel_id || null,
            s.num != null ? Number(s.num) || null : null
          );
        } catch (err) {
          skipped.channels++;
          console.warn('[sync] skipped a malformed channel:', err.message, JSON.stringify(s).slice(0, 200));
        }
      });

      // Programs are upserted, not wiped - a full wipe-and-reinsert every
      // sync briefly empties the table and touches every row even when
      // nothing changed. Prune only what's fallen outside the retention
      // window, then insert-or-update everything else by its natural key
      // (channel + start + stop). Programmes that disappear from the source
      // but are still inside the window are left alone rather than deleted -
      // a program the provider stops listing doesn't necessarily mean it's
      // gone, and this avoids flickering the guide on every sync.
      db.prepare('DELETE FROM programs WHERE start < ? OR start > ?').run(windowStart, windowEnd);
      const upsertProg = db.prepare(`
        INSERT INTO programs (epg_channel_id, title, description, start, stop)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(epg_channel_id, start, stop) DO UPDATE SET
          title = excluded.title,
          description = excluded.description
        WHERE title != excluded.title OR description IS NOT excluded.description
      `);
      let touched = 0;
      programmes.forEach((p) => {
        if (p.start < windowStart || p.start > windowEnd) return;
        if (!p.channel) { skipped.programmes++; return; }
        try {
          const info = upsertProg.run(String(p.channel), p.title || '(untitled)', p.description || '', p.start, p.stop);
          if (info.changes > 0) touched++;
        } catch (err) {
          skipped.programmes++;
          console.warn('[sync] skipped a malformed programme:', err.message, JSON.stringify(p).slice(0, 200));
        }
      });
      console.log(`[sync] programs: ${touched} added/updated out of ${programmes.length} in the source feed`);
    });
    tx();

    if (skipped.categories || skipped.channels || skipped.programmes) {
      console.warn(`[sync] completed with some entries skipped due to malformed data: ${skipped.categories} categories, ${skipped.channels} channels, ${skipped.programmes} programmes`);
    }

    setSetting('last_sync_at', Date.now());
    syncState.phase = 'done';
    syncState.skipped = skipped;
    console.log('[sync] completed successfully');
  } catch (err) {
    const failedPhase = syncState.phase;
    syncState.error = err.message;
    syncState.phase = 'error';
    console.error(`[sync] failed during phase "${failedPhase}":`, err.message);
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
