const cron = require('node-cron');
const { db, getSetting, setSetting } = require('./db');
const xc = require('./xcClient');
const { parseXmltv } = require('./xmltv');

const cronTasks = new Map();   // userId -> node-cron task
const syncStates = new Map();  // userId -> sync state

function freshState() {
  return { running: false, phase: null, error: null, startedAt: null, finishedAt: null, skipped: null, changes: null };
}

function getSyncState(userId) {
  const state = syncStates.get(userId) || freshState();
  return { ...state, lastSyncAt: getSetting(userId, 'last_sync_at', null) };
}

function requireCreds(userId) {
  const host = getSetting(userId, 'xc_host');
  const username = getSetting(userId, 'xc_username');
  const password = getSetting(userId, 'xc_password');
  if (!host || !username || !password) {
    throw new Error('XC server is not configured yet. Add your host, username and password in Settings.');
  }
  return { host, username, password };
}

async function performSync(userId) {
  const existing = syncStates.get(userId);
  if (existing && existing.running) {
    console.log(`[sync] user ${userId}: already running, ignoring duplicate trigger`);
    return existing;
  }
  let state = freshState();
  state.running = true;
  state.phase = 'starting';
  state.startedAt = Date.now();
  syncStates.set(userId, state);
  console.log(`[sync] user ${userId}: starting`);

  try {
    const { host, username, password } = requireCreds(userId);

    state.phase = 'categories';
    console.log(`[sync] user ${userId}: fetching categories from`, host);
    const categories = await xc.getLiveCategories(host, username, password);
    console.log(`[sync] user ${userId}: got ${categories.length} categories`);

    state.phase = 'channels';
    const streams = await xc.getLiveStreams(host, username, password);
    console.log(`[sync] user ${userId}: got ${streams.length} channels`);

    state.phase = 'epg';
    const activeEpgSourceId = getSetting(userId, 'active_epg_source_id', '');
    let xmltvText;
    if (activeEpgSourceId) {
      const source = db.prepare('SELECT * FROM epg_sources WHERE user_id = ? AND id = ?').get(userId, activeEpgSourceId);
      if (!source) {
        throw new Error(`Selected EPG source (id ${activeEpgSourceId}) no longer exists - pick another one in Settings.`);
      }
      console.log(`[sync] user ${userId}: fetching EPG from custom source "${source.name}": ${source.url}`);
      xmltvText = await xc.fetchGenericXmltv(source.url);
    } else {
      console.log(`[sync] user ${userId}: fetching EPG from XC server xmltv.php`);
      xmltvText = await xc.fetchXmltv(host, username, password);
    }
    console.log(`[sync] user ${userId}: fetched xmltv (${xmltvText.length} bytes)`);
    const { programmes } = parseXmltv(xmltvText);
    console.log(`[sync] user ${userId}: parsed ${programmes.length} programmes from xmltv`);

    state.phase = 'saving';
    const now = Date.now();
    const retentionCutoff = now - 24 * 60 * 60 * 1000; // wipe programs 24h after they finish, not after they started
    const windowEnd = now + 8 * 24 * 60 * 60 * 1000;   // keep up to 8 days ahead

    const skipped = { categories: 0, channels: 0, programmes: 0 };
    const changes = { categoriesAdded: 0, categoriesUpdated: 0, categoriesRemoved: 0,
                       channelsAdded: 0, channelsUpdated: 0, channelsRemoved: 0 };

    const tx = db.transaction(() => {
      const existingCategoryIds = new Set(
        db.prepare('SELECT id FROM categories WHERE user_id = ?').all(userId).map((r) => r.id)
      );
      const upsertCat = db.prepare(`
        INSERT INTO categories (user_id, id, name, sort_order) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, sort_order = excluded.sort_order
        WHERE name != excluded.name OR sort_order != excluded.sort_order
      `);
      const knownCategoryIds = new Set();
      categories.forEach((c, i) => {
        if (c.category_id === undefined || c.category_id === null) { skipped.categories++; return; }
        const id = String(c.category_id);
        try {
          const info = upsertCat.run(userId, id, c.category_name != null ? String(c.category_name) : '(Unnamed)', i);
          if (info.changes > 0) {
            if (existingCategoryIds.has(id)) changes.categoriesUpdated++; else changes.categoriesAdded++;
          }
          knownCategoryIds.add(id);
        } catch (err) {
          skipped.categories++;
          console.warn(`[sync] user ${userId}: skipped a malformed category:`, err.message, JSON.stringify(c).slice(0, 200));
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
        const info = upsertCat.run(userId, id, `Uncategorized (${id})`, nextSortOrder++);
        if (info.changes > 0 && !existingCategoryIds.has(id)) changes.categoriesAdded++;
        knownCategoryIds.add(id);
      });
      if (orphanedCategoryIds.size > 0) {
        console.warn(`[sync] user ${userId}: ${orphanedCategoryIds.size} category id(s) referenced by channels weren't in get_live_categories - created placeholder categories for them so those channels stay visible`);
      }

      // Only prune categories that are confirmed gone - if the provider
      // returned nothing usable this round (categories AND streams both
      // empty), that's much more likely a transient glitch than every
      // category being genuinely deleted, so skip pruning rather than wipe
      // everything out over what's probably a blip.
      if (knownCategoryIds.size > 0) {
        const toRemove = [...existingCategoryIds].filter((id) => !knownCategoryIds.has(id));
        if (toRemove.length > 0) {
          const placeholders = toRemove.map(() => '?').join(',');
          db.prepare(`DELETE FROM categories WHERE user_id = ? AND id IN (${placeholders})`).run(userId, ...toRemove);
          changes.categoriesRemoved = toRemove.length;
        }
      } else if (existingCategoryIds.size > 0) {
        console.warn(`[sync] user ${userId}: provider returned no usable categories this sync - leaving existing categories untouched rather than deleting them (likely a transient glitch)`);
      }

      const existingChannelIds = new Set(
        db.prepare('SELECT id FROM channels WHERE user_id = ?').all(userId).map((r) => r.id)
      );
      const upsertChan = db.prepare(`
        INSERT INTO channels (user_id, id, name, logo, category_id, epg_channel_id, stream_num)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, id) DO UPDATE SET
          name = excluded.name, logo = excluded.logo, category_id = excluded.category_id,
          epg_channel_id = excluded.epg_channel_id, stream_num = excluded.stream_num
        WHERE name != excluded.name OR logo IS NOT excluded.logo OR category_id != excluded.category_id
           OR epg_channel_id IS NOT excluded.epg_channel_id OR stream_num IS NOT excluded.stream_num
      `);
      const freshChannelIds = new Set();
      streams.forEach((s) => {
        if (s.stream_id === undefined || s.stream_id === null) { skipped.channels++; return; }
        const id = String(s.stream_id);
        try {
          const info = upsertChan.run(
            userId,
            id,
            s.name != null ? String(s.name) : `Channel ${s.stream_id}`,
            s.stream_icon || null,
            s.category_id != null ? String(s.category_id) : '',
            s.epg_channel_id || null,
            s.num != null ? Number(s.num) || null : null
          );
          if (info.changes > 0) {
            if (existingChannelIds.has(id)) changes.channelsUpdated++; else changes.channelsAdded++;
          }
          freshChannelIds.add(id);
        } catch (err) {
          skipped.channels++;
          console.warn(`[sync] user ${userId}: skipped a malformed channel:`, err.message, JSON.stringify(s).slice(0, 200));
        }
      });

      // Same transient-glitch guard as categories above.
      if (freshChannelIds.size > 0) {
        const toRemove = [...existingChannelIds].filter((id) => !freshChannelIds.has(id));
        if (toRemove.length > 0) {
          const placeholders = toRemove.map(() => '?').join(',');
          db.prepare(`DELETE FROM channels WHERE user_id = ? AND id IN (${placeholders})`).run(userId, ...toRemove);
          changes.channelsRemoved = toRemove.length;
        }
      } else if (existingChannelIds.size > 0) {
        console.warn(`[sync] user ${userId}: provider returned no usable channels this sync - leaving existing channels untouched rather than deleting them (likely a transient glitch)`);
      }

      console.log(`[sync] user ${userId}: categories +${changes.categoriesAdded} ~${changes.categoriesUpdated} -${changes.categoriesRemoved}, channels +${changes.channelsAdded} ~${changes.channelsUpdated} -${changes.channelsRemoved}`);

      // Programs are upserted, not wiped - a full wipe-and-reinsert every
      // sync briefly empties the table and touches every row even when
      // nothing changed. Prune only what's fallen outside the retention
      // window (a program is kept until 24h after it FINISHES, not 24h
      // after it started - a long program shouldn't vanish mid-air), then
      // insert-or-update everything else by its natural key (channel +
      // start + stop). Programmes that disappear from the source but are
      // still inside the window are left alone rather than deleted - a
      // program the provider stops listing doesn't necessarily mean it's
      // gone, and this avoids flickering the guide on every sync.
      db.prepare('DELETE FROM programs WHERE user_id = ? AND (stop < ? OR start > ?)').run(userId, retentionCutoff, windowEnd);
      const upsertProg = db.prepare(`
        INSERT INTO programs (user_id, epg_channel_id, title, description, start, stop)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, epg_channel_id, start, stop) DO UPDATE SET
          title = excluded.title,
          description = excluded.description
        WHERE title != excluded.title OR description IS NOT excluded.description
      `);
      let touched = 0;
      programmes.forEach((p) => {
        if (p.stop < retentionCutoff || p.start > windowEnd) return;
        if (!p.channel) { skipped.programmes++; return; }
        try {
          const info = upsertProg.run(userId, String(p.channel), p.title || '(untitled)', p.description || '', p.start, p.stop);
          if (info.changes > 0) touched++;
        } catch (err) {
          skipped.programmes++;
          console.warn(`[sync] user ${userId}: skipped a malformed programme:`, err.message, JSON.stringify(p).slice(0, 200));
        }
      });
      console.log(`[sync] user ${userId}: programs: ${touched} added/updated out of ${programmes.length} in the source feed`);
    });
    tx();

    if (skipped.categories || skipped.channels || skipped.programmes) {
      console.warn(`[sync] user ${userId}: completed with some entries skipped due to malformed data: ${skipped.categories} categories, ${skipped.channels} channels, ${skipped.programmes} programmes`);
    }

    setSetting(userId, 'last_sync_at', Date.now());
    state.phase = 'done';
    state.skipped = skipped;
    state.changes = changes;
    console.log(`[sync] user ${userId}: completed successfully`);
  } catch (err) {
    const failedPhase = state.phase;
    state.error = err.message;
    state.phase = 'error';
    console.error(`[sync] user ${userId}: failed during phase "${failedPhase}":`, err.message);
    throw err;
  } finally {
    state.running = false;
    state.finishedAt = Date.now();
  }

  return state;
}

function pruneOldPrograms() {
  const retentionCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const info = db.prepare('DELETE FROM programs WHERE stop < ?').run(retentionCutoff);
  if (info.changes > 0) {
    console.log(`[cleanup] pruned ${info.changes} program(s) that finished more than 24h ago (across all users)`);
  }
}

function scheduleAutoSync(userId, hours) {
  const existing = cronTasks.get(userId);
  if (existing) {
    existing.stop();
    cronTasks.delete(userId);
  }
  const h = Number(hours) || 0;
  setSetting(userId, 'auto_sync_hours', h);
  if (h > 0) {
    // node-cron supports step values in the hour field, e.g. "0 */4 * * *"
    const expr = `0 */${h} * * *`;
    const task = cron.schedule(expr, () => {
      performSync(userId).catch((err) => console.error(`[auto-sync] user ${userId} failed:`, err.message));
    });
    cronTasks.set(userId, task);
  }
}

function initScheduler() {
  // schedule auto-sync for every existing user, based on their stored
  // preference (or the default) so this survives container restarts
  const allUserIds = db.prepare('SELECT id FROM users').all().map((r) => r.id);
  allUserIds.forEach((userId) => {
    const hours = Number(getSetting(userId, 'auto_sync_hours', 4)) || 0;
    scheduleAutoSync(userId, hours);
  });

  // Independent of sync (which only prunes as a side effect of running at
  // all) - guarantees the 24h-after-finish retention promise holds even if
  // auto-sync is off or set to a long interval.
  pruneOldPrograms();
  setInterval(pruneOldPrograms, 60 * 60 * 1000);
}

module.exports = { performSync, scheduleAutoSync, initScheduler, getSyncState, pruneOldPrograms };
