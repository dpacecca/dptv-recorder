const express = require('express');
const { db, getSetting, setSetting } = require('./db');
const xc = require('./xcClient');
const { performSync, scheduleAutoSync, getSyncState } = require('./sync');
const { hlsProxyHandler } = require('./hlsProxy');
const { buildStreamEntryPath } = require('./streamEntry');
const recorder = require('./recorder');
const notifier = require('./notifier');
const auth = require('./auth');

const router = express.Router();

// Everything below requires a signed-in user with no pending forced
// password change. The HLS proxy is deliberately mounted separately (see
// bottom of file / index.js) since ffmpeg hits it directly with no cookies -
// its security model is the opaque per-stream token, not a session.
router.use(auth.requireAuth);

// ---------- settings (XC server) ----------
router.get('/settings', (req, res) => {
  const userId = req.user.id;
  res.json({
    xcHost: getSetting(userId, 'xc_host', ''),
    xcUsername: getSetting(userId, 'xc_username', ''),
    hasPassword: !!getSetting(userId, 'xc_password', ''),
    autoSyncHours: Number(getSetting(userId, 'auto_sync_hours', 4)),
    lastSyncAt: getSetting(userId, 'last_sync_at', null),
  });
});

router.post('/settings', async (req, res) => {
  const userId = req.user.id;
  const { xcHost, xcUsername, xcPassword, autoSyncHours } = req.body || {};
  try {
    if (xcHost && xcUsername && xcPassword) {
      await xc.testAuth(xcHost, xcUsername, xcPassword); // validate before saving
      setSetting(userId, 'xc_host', xcHost);
      setSetting(userId, 'xc_username', xcUsername);
      setSetting(userId, 'xc_password', xcPassword);
    }
    if (autoSyncHours !== undefined) {
      scheduleAutoSync(userId, autoSyncHours);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---------- sync ----------
router.post('/sync', (req, res) => {
  const userId = req.user.id;
  performSync(userId).catch((err) => console.error(`[sync] user ${userId} failed:`, err.message, err.stack));
  res.json({ started: true });
});

router.get('/sync/status', (req, res) => {
  res.json(getSyncState(req.user.id));
});

// ---------- categories ----------
router.get('/categories', (req, res) => {
  const userId = req.user.id;
  const rows = db.prepare(`
    SELECT c.id, c.name,
      (SELECT COUNT(*) FROM channels ch WHERE ch.user_id = c.user_id AND ch.category_id = c.id) AS channelCount
    FROM categories c WHERE c.user_id = ? ORDER BY c.sort_order ASC
  `).all(userId);
  res.json(rows);
});

// ---------- channels ----------
router.get('/channels', (req, res) => {
  const userId = req.user.id;
  const { category_id } = req.query;
  let rows;
  if (category_id) {
    rows = db.prepare('SELECT * FROM channels WHERE user_id = ? AND category_id = ? ORDER BY stream_num ASC, name ASC')
      .all(userId, category_id);
  } else {
    rows = db.prepare('SELECT * FROM channels WHERE user_id = ? ORDER BY stream_num ASC, name ASC').all(userId);
  }
  res.json(rows);
});

// ---------- epg ----------
// GET /api/epg?category_id=X&start=<epochMs>&end=<epochMs>
// Returns { channels: [...], programs: { [channelId]: [{start,stop,title,description}] } }
router.get('/epg', (req, res) => {
  const userId = req.user.id;
  const { category_id, start, end } = req.query;
  const startMs = Number(start) || Date.now() - 24 * 60 * 60 * 1000;
  const endMs = Number(end) || Date.now() + 7 * 24 * 60 * 60 * 1000;

  const channels = category_id
    ? db.prepare('SELECT * FROM channels WHERE user_id = ? AND category_id = ? ORDER BY stream_num ASC, name ASC').all(userId, category_id)
    : db.prepare('SELECT * FROM channels WHERE user_id = ? ORDER BY stream_num ASC, name ASC').all(userId);

  const progStmt = db.prepare(`
    SELECT title, description, start, stop FROM programs
    WHERE user_id = ? AND epg_channel_id = ? AND start < ? AND stop > ?
    ORDER BY start ASC
  `);

  const programs = {};
  for (const ch of channels) {
    if (!ch.epg_channel_id) { programs[ch.id] = []; continue; }
    programs[ch.id] = progStmt.all(userId, ch.epg_channel_id, endMs, startMs);
  }

  res.json({ channels, programs });
});

// ---------- search ----------
router.get('/search', (req, res) => {
  const userId = req.user.id;
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ channels: [], programs: [] });
  const like = `%${q}%`;

  const channels = db.prepare('SELECT * FROM channels WHERE user_id = ? AND name LIKE ? LIMIT 50').all(userId, like);

  const programs = db.prepare(`
    SELECT p.title, p.description, p.start, p.stop, ch.id AS channelId, ch.name AS channelName, ch.category_id AS categoryId
    FROM programs p
    JOIN channels ch ON ch.user_id = p.user_id AND ch.epg_channel_id = p.epg_channel_id
    WHERE p.user_id = ? AND p.title LIKE ? AND p.stop > ?
    ORDER BY p.start ASC
    LIMIT 100
  `).all(userId, like, Date.now());

  res.json({ channels, programs });
});

// ---------- notification settings ----------
router.get('/settings/notifications', (req, res) => {
  const userId = req.user.id;
  res.json({
    gotifyUrl: getSetting(userId, 'gotify_url', ''),
    hasToken: !!getSetting(userId, 'gotify_token', ''),
    notifyStarted: getSetting(userId, 'notify_started', '1') === '1',
    notifyCompleted: getSetting(userId, 'notify_completed', '1') === '1',
    notifyFailed: getSetting(userId, 'notify_failed', '1') === '1',
  });
});

router.post('/settings/notifications', (req, res) => {
  const userId = req.user.id;
  const { gotifyUrl, gotifyToken, notifyStarted, notifyCompleted, notifyFailed } = req.body || {};
  if (gotifyUrl !== undefined) setSetting(userId, 'gotify_url', gotifyUrl);
  if (gotifyToken) setSetting(userId, 'gotify_token', gotifyToken); // blank = keep the existing token
  if (notifyStarted !== undefined) setSetting(userId, 'notify_started', notifyStarted ? '1' : '0');
  if (notifyCompleted !== undefined) setSetting(userId, 'notify_completed', notifyCompleted ? '1' : '0');
  if (notifyFailed !== undefined) setSetting(userId, 'notify_failed', notifyFailed ? '1' : '0');
  res.json({ ok: true });
});

router.post('/settings/notifications/test', async (req, res) => {
  const result = await notifier.sendGotify(
    req.user.id,
    'DPTV Recorder',
    'This is a test notification - if you can see this, Gotify is set up correctly.',
    3
  );
  if (result.ok) res.json({ ok: true });
  else res.status(400).json({ ok: false, error: result.error });
});

// ---------- recording settings ----------
router.get('/settings/recording', (req, res) => {
  res.json(recorder.getRecordingSettings(req.user.id));
});

router.post('/settings/recording', (req, res) => {
  try {
    recorder.setRecordingSettings(req.user.id, req.body || {});
    res.json({ ok: true, ...recorder.getRecordingSettings(req.user.id) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// ---------- EPG sources ----------
router.get('/epg-sources', (req, res) => {
  const userId = req.user.id;
  const sources = db.prepare('SELECT * FROM epg_sources WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  res.json({
    sources,
    activeEpgSourceId: getSetting(userId, 'active_epg_source_id', '') || '',
  });
});

router.post('/epg-sources', (req, res) => {
  const userId = req.user.id;
  const { name, url } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name and url are required' });
  try {
    new URL(url); // throws on anything obviously malformed
  } catch {
    return res.status(400).json({ error: 'That URL does not look valid.' });
  }
  const info = db.prepare('INSERT INTO epg_sources (user_id, name, url, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, name, url, Date.now());
  res.json(db.prepare('SELECT * FROM epg_sources WHERE id = ?').get(info.lastInsertRowid));
});

router.delete('/epg-sources/:id', (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);
  db.prepare('DELETE FROM epg_sources WHERE user_id = ? AND id = ?').run(userId, id);
  // if the deleted source was the active one, fall back to the XC server's own EPG
  if (String(getSetting(userId, 'active_epg_source_id', '')) === String(id)) {
    setSetting(userId, 'active_epg_source_id', '');
  }
  res.json({ ok: true });
});

router.post('/epg-sources/active', (req, res) => {
  const userId = req.user.id;
  const { id } = req.body || {}; // empty/falsy id => use the XC server's own xmltv.php
  if (id) {
    const source = db.prepare('SELECT * FROM epg_sources WHERE user_id = ? AND id = ?').get(userId, id);
    if (!source) return res.status(400).json({ error: 'That EPG source no longer exists.' });
  }
  setSetting(userId, 'active_epg_source_id', id || '');
  res.json({ ok: true });
});

// ---------- recordings ----------
router.get('/recordings', (req, res) => {
  res.json(recorder.listRecordings(req.user.id));
});

router.get('/recordings/for-program', (req, res) => {
  const { channel_id, start, stop } = req.query;
  const row = recorder.findForProgram(req.user.id, channel_id, Number(start), Number(stop));
  res.json(row || null);
});

router.post('/recordings', (req, res) => {
  const { channelId, channelName, programTitle, programStart, programStop } = req.body || {};
  if (!channelId || !programTitle || !programStart || !programStop) {
    return res.status(400).json({ error: 'channelId, programTitle, programStart, programStop are required' });
  }
  try {
    const row = recorder.scheduleRecording(req.user.id, {
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
      recorder.deleteRecording(req.user.id, Number(req.params.id));
    } else {
      recorder.cancelRecording(req.user.id, Number(req.params.id));
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
  try {
    const streamPath = buildStreamEntryPath(req.user.id, req.params.channelId);
    res.redirect(streamPath);
  } catch (err) {
    const status = err.message === 'channel not found' ? 404 : 400;
    res.status(status).send(err.message);
  }
});

module.exports = router;
