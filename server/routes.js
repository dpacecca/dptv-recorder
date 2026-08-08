const express = require('express');
const { db, getSetting, setSetting } = require('./db');
const xc = require('./xcClient');
const { performSync, scheduleAutoSync, getSyncState } = require('./sync');
const { makeToken, hlsProxyHandler } = require('./hlsProxy');
const recorder = require('./recorder');

const router = express.Router();

// ---------- settings ----------
router.get('/settings', (req, res) => {
  res.json({
    xcHost: getSetting('xc_host', ''),
    xcUsername: getSetting('xc_username', ''),
    hasPassword: !!getSetting('xc_password', ''),
    autoSyncHours: Number(getSetting('auto_sync_hours', 4)),
    lastSyncAt: getSetting('last_sync_at', null),
  });
});

router.post('/settings', async (req, res) => {
  const { xcHost, xcUsername, xcPassword, autoSyncHours } = req.body || {};
  try {
    if (xcHost && xcUsername && xcPassword) {
      await xc.testAuth(xcHost, xcUsername, xcPassword); // validate before saving
      setSetting('xc_host', xcHost);
      setSetting('xc_username', xcUsername);
      setSetting('xc_password', xcPassword);
    }
    if (autoSyncHours !== undefined) {
      scheduleAutoSync(autoSyncHours);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---------- sync ----------
router.post('/sync', (req, res) => {
  performSync().catch((err) => console.error('[sync] failed:', err.message, err.stack)); // full detail also polled via /api/sync/status
  res.json({ started: true });
});

router.get('/sync/status', (req, res) => {
  res.json(getSyncState());
});

// ---------- categories ----------
router.get('/categories', (req, res) => {
  const rows = db.prepare(`
    SELECT c.id, c.name,
      (SELECT COUNT(*) FROM channels ch WHERE ch.category_id = c.id) AS channelCount
    FROM categories c ORDER BY c.sort_order ASC
  `).all();
  res.json(rows);
});

// ---------- channels ----------
router.get('/channels', (req, res) => {
  const { category_id } = req.query;
  let rows;
  if (category_id) {
    rows = db.prepare('SELECT * FROM channels WHERE category_id = ? ORDER BY stream_num ASC, name ASC')
      .all(category_id);
  } else {
    rows = db.prepare('SELECT * FROM channels ORDER BY stream_num ASC, name ASC').all();
  }
  res.json(rows);
});

// ---------- epg ----------
// GET /api/epg?category_id=X&start=<epochMs>&end=<epochMs>
// Returns { channels: [...], programs: { [channelId]: [{start,stop,title,description}] } }
router.get('/epg', (req, res) => {
  const { category_id, start, end } = req.query;
  const startMs = Number(start) || Date.now() - 24 * 60 * 60 * 1000;
  const endMs = Number(end) || Date.now() + 7 * 24 * 60 * 60 * 1000;

  const channels = category_id
    ? db.prepare('SELECT * FROM channels WHERE category_id = ? ORDER BY stream_num ASC, name ASC').all(category_id)
    : db.prepare('SELECT * FROM channels ORDER BY stream_num ASC, name ASC').all();

  const progStmt = db.prepare(`
    SELECT title, description, start, stop FROM programs
    WHERE epg_channel_id = ? AND start < ? AND stop > ?
    ORDER BY start ASC
  `);

  const programs = {};
  for (const ch of channels) {
    if (!ch.epg_channel_id) { programs[ch.id] = []; continue; }
    programs[ch.id] = progStmt.all(ch.epg_channel_id, endMs, startMs);
  }

  res.json({ channels, programs });
});

// ---------- search ----------
router.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ channels: [], programs: [] });
  const like = `%${q}%`;

  const channels = db.prepare('SELECT * FROM channels WHERE name LIKE ? LIMIT 50').all(like);

  const programs = db.prepare(`
    SELECT p.title, p.description, p.start, p.stop, ch.id AS channelId, ch.name AS channelName, ch.category_id AS categoryId
    FROM programs p
    JOIN channels ch ON ch.epg_channel_id = p.epg_channel_id
    WHERE p.title LIKE ? AND p.stop > ?
    ORDER BY p.start ASC
    LIMIT 100
  `).all(like, Date.now());

  res.json({ channels, programs });
});

// ---------- recording settings ----------
router.get('/settings/recording', (req, res) => {
  res.json(recorder.getRecordingSettings());
});

router.post('/settings/recording', (req, res) => {
  try {
    recorder.setRecordingSettings(req.body || {});
    res.json({ ok: true, ...recorder.getRecordingSettings() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---------- EPG sources ----------
router.get('/epg-sources', (req, res) => {
  const sources = db.prepare('SELECT * FROM epg_sources ORDER BY created_at ASC').all();
  res.json({
    sources,
    activeEpgSourceId: getSetting('active_epg_source_id', '') || '',
  });
});

router.post('/epg-sources', (req, res) => {
  const { name, url } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
  try {
    new URL(url); // throws on anything obviously malformed
  } catch {
    return res.status(400).json({ error: 'That URL does not look valid.' });
  }
  const info = db.prepare('INSERT INTO epg_sources (name, url, created_at) VALUES (?, ?, ?)')
    .run(name, url, Date.now());
  res.json(db.prepare('SELECT * FROM epg_sources WHERE id = ?').get(info.lastInsertRowid));
});

router.delete('/epg-sources/:id', (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM epg_sources WHERE id = ?').run(id);
  // if the deleted source was the active one, fall back to the XC server's own EPG
  if (String(getSetting('active_epg_source_id', '')) === String(id)) {
    setSetting('active_epg_source_id', '');
  }
  res.json({ ok: true });
});

router.post('/epg-sources/active', (req, res) => {
  const { id } = req.body || {}; // empty/falsy id => use the XC server's own xmltv.php
  if (id) {
    const source = db.prepare('SELECT * FROM epg_sources WHERE id = ?').get(id);
    if (!source) return res.status(400).json({ error: 'That EPG source no longer exists.' });
  }
  setSetting('active_epg_source_id', id || '');
  res.json({ ok: true });
});

// ---------- recordings ----------
router.get('/recordings', (req, res) => {
  res.json(recorder.listRecordings());
});

router.get('/recordings/for-program', (req, res) => {
  const { channel_id, start, stop } = req.query;
  const row = recorder.findForProgram(channel_id, Number(start), Number(stop));
  res.json(row || null);
});

router.post('/recordings', (req, res) => {
  const { channelId, channelName, programTitle, programStart, programStop } = req.body || {};
  if (!channelId || !programTitle || !programStart || !programStop) {
    return res.status(400).json({ error: 'channelId, programTitle, programStart, programStop are required' });
  }
  try {
    const row = recorder.scheduleRecording({
      channelId, channelName, programTitle,
      programStart: Number(programStart), programStop: Number(programStop),
    });
    res.json(row);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/recordings/:id', (req, res) => {
  try {
    const status = req.query.status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      recorder.deleteRecording(Number(req.params.id));
    } else {
      recorder.cancelRecording(Number(req.params.id));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- streaming ----------
// GET /api/stream/:channelId -> mints a fresh proxy token for this channel's
// live .m3u8 and redirects the player there. Credentials never leave the server.
router.get('/stream/:channelId', (req, res) => {
  const host = getSetting('xc_host');
  const username = getSetting('xc_username');
  const password = getSetting('xc_password');
  if (!host || !username || !password) {
    return res.status(400).send('XC server not configured');
  }
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.channelId);
  if (!channel) return res.status(404).send('channel not found');

  const upstreamUrl = xc.liveStreamUrl(host, username, password, channel.id, 'm3u8');
  const token = makeToken(upstreamUrl);
  res.redirect(`/api/hls?u=${token}`);
});

router.get('/hls', hlsProxyHandler);

module.exports = router;
