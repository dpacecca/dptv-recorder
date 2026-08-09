const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db, getSetting, setSetting } = require('./db');

const RECORDINGS_DIR = process.env.RECORDINGS_PATH || '/recordings';
const PORT = process.env.PORT || 3000;
const TICK_MS = 15000;

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// recordingId -> { proc }
const activeProcs = new Map();
let tickTimer = null;

function padMinutes() {
  return {
    before: Number(getSetting('record_pad_before_min', 2)) || 0,
    after: Number(getSetting('record_pad_after_min', 5)) || 0,
  };
}

function safeFilenamePart(str) {
  return String(str).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

function buildFilename(row) {
  const d = new Date(row.rec_start);
  const stamp = d.toISOString().replace(/[:T]/g, '-').slice(0, 16);
  return `${safeFilenamePart(row.channel_name)}_${safeFilenamePart(row.program_title)}_${stamp}.ts`;
}

function rowById(id) {
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
}

function listRecordings() {
  return db.prepare('SELECT * FROM recordings ORDER BY rec_start DESC LIMIT 200').all();
}

function findForProgram(channelId, programStart, programStop) {
  return db.prepare(`
    SELECT * FROM recordings
    WHERE channel_id = ? AND program_start = ? AND program_stop = ? AND status != 'cancelled'
    ORDER BY id DESC LIMIT 1
  `).get(channelId, programStart, programStop);
}

// ---------------- scheduling ----------------
function scheduleRecording({ channelId, channelName, programTitle, programStart, programStop }) {
  const existing = findForProgram(channelId, programStart, programStop);
  if (existing && ['scheduled', 'recording', 'completed'].includes(existing.status)) {
    return existing; // already scheduled/recording/recorded - don't duplicate
  }

  const { before, after } = padMinutes();
  const now = Date.now();
  let recStart = programStart - before * 60000;
  const recEnd = programStop + after * 60000;
  if (recStart < now) recStart = now; // program already airing (or padding pushed us into the past)
  if (recEnd <= now) {
    throw new Error('This program has already ended.');
  }

  const info = db.prepare(`
    INSERT INTO recordings (channel_id, channel_name, program_title, program_start, program_stop, rec_start, rec_end, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
  `).run(channelId, channelName, programTitle, programStart, programStop, recStart, recEnd, now);

  const row = rowById(info.lastInsertRowid);
  if (recStart <= now) startRecording(row); // starts immediately if within the window right now
  return rowById(row.id);
}

function startRecording(row) {
  if (activeProcs.has(row.id)) return;

  const filename = buildFilename(row);
  const outputPath = path.join(RECORDINGS_DIR, filename);
  const durationSec = Math.max(1, Math.round((row.rec_end - Date.now()) / 1000));
  const streamUrl = `http://127.0.0.1:${PORT}/api/stream/${encodeURIComponent(row.channel_id)}`;

  const args = [
    '-y',
    '-allowed_extensions', 'ALL', // belt-and-suspenders: proxy URLs now carry real extensions,
                                  // but some providers use segment extensions outside ffmpeg's
                                  // built-in whitelist (e.g. unusual fMP4 naming) - this avoids
                                  // that whole class of "not in allowed_segment_extensions" failures
    '-i', streamUrl,
    '-c', 'copy',
    '-f', 'mpegts',
    '-t', String(durationSec),
    outputPath,
  ];

  let proc;
  try {
    proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    db.prepare(`UPDATE recordings SET status='failed', error=? WHERE id=?`).run('Could not start ffmpeg: ' + err.message, row.id);
    return;
  }

  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  db.prepare(`UPDATE recordings SET status='recording', filename=? WHERE id=?`).run(filename, row.id);
  activeProcs.set(row.id, { proc });

  proc.on('close', (code) => {
    activeProcs.delete(row.id);
    const current = rowById(row.id);
    if (!current || current.status === 'cancelled') return; // cancelRecording already handled cleanup

    if (code === 0) {
      db.prepare(`UPDATE recordings SET status='completed' WHERE id=?`).run(row.id);
    } else {
      db.prepare(`UPDATE recordings SET status='failed', error=? WHERE id=?`)
        .run(`ffmpeg exited with code ${code}: ${stderrTail.split('\n').filter(Boolean).slice(-8).join(' | ').trim()}`, row.id);
    }
  });

  proc.on('error', (err) => {
    activeProcs.delete(row.id);
    db.prepare(`UPDATE recordings SET status='failed', error=? WHERE id=?`).run('ffmpeg error: ' + err.message, row.id);
  });
}

function cancelRecording(id) {
  const row = rowById(id);
  if (!row) throw new Error('Recording not found');

  const active = activeProcs.get(id);
  if (active) {
    active.proc.kill('SIGTERM');
    activeProcs.delete(id);
  }

  db.prepare(`UPDATE recordings SET status='cancelled' WHERE id=?`).run(id);

  // best-effort cleanup of a partial/complete local file
  if (row.filename) {
    const p = path.join(RECORDINGS_DIR, row.filename);
    fs.unlink(p, () => {});
  }
}

function deleteRecording(id) {
  const row = rowById(id);
  if (!row) throw new Error('Recording not found');
  if (activeProcs.has(id)) throw new Error('Recording is in progress - cancel it first.');
  if (row.filename) {
    const p = path.join(RECORDINGS_DIR, row.filename);
    fs.unlink(p, () => {});
  }
  db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
}

// ---------------- ticker ----------------
function tick() {
  const now = Date.now();
  const due = db.prepare(`SELECT * FROM recordings WHERE status='scheduled' AND rec_start <= ?`).all(now);
  due.forEach(startRecording);

  // safety net: if something is still marked "recording" well past its end time
  // (e.g. ffmpeg hung), stop it rather than let it run forever.
  const overdue = db.prepare(`SELECT * FROM recordings WHERE status='recording' AND rec_end <= ?`).all(now - 30000);
  overdue.forEach((row) => {
    const active = activeProcs.get(row.id);
    if (active) active.proc.kill('SIGTERM');
  });
}

function init() {
  // any row still "recording" from before a restart couldn't have kept its ffmpeg process alive
  db.prepare(`UPDATE recordings SET status='failed', error='Interrupted by a server restart' WHERE status='recording'`).run();
  tickTimer = setInterval(tick, TICK_MS);
  tick();
}

function getRecordingSettings() {
  const { before, after } = padMinutes();
  return { padBeforeMin: before, padAfterMin: after, recordingsPath: RECORDINGS_DIR };
}

function setRecordingSettings({ padBeforeMin, padAfterMin }) {
  if (padBeforeMin !== undefined) setSetting('record_pad_before_min', Math.max(0, Number(padBeforeMin) || 0));
  if (padAfterMin !== undefined) setSetting('record_pad_after_min', Math.max(0, Number(padAfterMin) || 0));
}

module.exports = {
  init,
  scheduleRecording,
  cancelRecording,
  deleteRecording,
  listRecordings,
  findForProgram,
  getRecordingSettings,
  setRecordingSettings,
  RECORDINGS_DIR,
};
