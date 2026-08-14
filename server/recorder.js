const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { db, getSetting, setSetting } = require('./db');
const notifier = require('./notifier');
const { buildStreamEntryPath } = require('./streamEntry');

const BASE_RECORDINGS_DIR = process.env.RECORDINGS_PATH || '/recordings';
const PORT = process.env.PORT || 3000;
const TICK_MS = 15000;

fs.mkdirSync(BASE_RECORDINGS_DIR, { recursive: true });
console.log(`[recorder] recordings will be written under: ${BASE_RECORDINGS_DIR} (one subfolder per user)`);
if (BASE_RECORDINGS_DIR !== '/recordings') {
  console.warn(
    `[recorder] WARNING: RECORDINGS_PATH is set to "${BASE_RECORDINGS_DIR}", not the default "/recordings". ` +
    `This must be a path INSIDE the container that you've mounted a volume to (e.g. via docker-compose's ` +
    `"volumes:" section) - it should NOT be a host filesystem path like "/mnt/user/...". If it is a host ` +
    `path, ffmpeg is writing files inside the container's own filesystem, which won't show up on your host ` +
    `and will be lost on restart. Check your container's environment variables/volume mappings.`
  );
}

function userRecordingsDir(userId) {
  const dir = path.join(BASE_RECORDINGS_DIR, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// recordingId -> { proc }
const activeProcs = new Map();
let tickTimer = null;

function padMinutes(userId) {
  return {
    before: Number(getSetting(userId, 'record_pad_before_min', 2)) || 0,
    after: Number(getSetting(userId, 'record_pad_after_min', 5)) || 0,
  };
}

function recordFormat(userId) {
  const f = getSetting(userId, 'record_format', 'ts');
  return ['ts', 'mkv', 'mkv_post'].includes(f) ? f : 'ts'; // whitelist - never trust an unexpected stored value
}

function safeFilenamePart(str) {
  return String(str).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 100);
}

function buildFilename(row, ext) {
  const d = new Date(row.rec_start);
  const stamp = d.toISOString().replace(/[:T]/g, '-').slice(0, 16);
  return `${safeFilenamePart(row.program_title)}_${stamp}.${ext}`;
}

function rowById(id) {
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
}

// scoped variant used anywhere a user is acting on their own recording, so
// one user can never see/cancel/delete another user's row by guessing an id
function ownedRowById(userId, id) {
  return db.prepare('SELECT * FROM recordings WHERE user_id = ? AND id = ?').get(userId, id);
}

function listRecordings(userId) {
  return db.prepare('SELECT * FROM recordings WHERE user_id = ? ORDER BY rec_start DESC LIMIT 200').all(userId);
}

function findForProgram(userId, channelId, programStart, programStop) {
  return db.prepare(`
    SELECT * FROM recordings
    WHERE user_id = ? AND channel_id = ? AND program_start = ? AND program_stop = ? AND status != 'cancelled'
    ORDER BY id DESC LIMIT 1
  `).get(userId, channelId, programStart, programStop);
}

// ---------------- scheduling ----------------
function scheduleRecording(userId, { channelId, channelName, programTitle, programStart, programStop }) {
  const existing = findForProgram(userId, channelId, programStart, programStop);
  if (existing && ['scheduled', 'recording', 'completed'].includes(existing.status)) {
    return existing; // already scheduled/recording/recorded - don't duplicate
  }

  const { before, after } = padMinutes(userId);
  const now = Date.now();
  let recStart = programStart - before * 60000;
  const recEnd = programStop + after * 60000;
  if (recStart < now) recStart = now; // program already airing (or padding pushed us into the past)
  if (recEnd <= now) {
    throw new Error('This program has already ended.');
  }

  const info = db.prepare(`
    INSERT INTO recordings (user_id, channel_id, channel_name, program_title, program_start, program_stop, rec_start, rec_end, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)
  `).run(userId, channelId, channelName, programTitle, programStart, programStop, recStart, recEnd, now);

  const row = rowById(info.lastInsertRowid);
  if (recStart <= now) startRecording(row); // starts immediately if within the window right now
  return rowById(row.id);
}

function remuxToMkv(row, tsPath) {
  const mkvPath = tsPath.replace(/\.ts$/, '.mkv');
  const mkvFilename = path.basename(mkvPath);
  console.log(`[recorder] #${row.id} remuxing to .mkv -> ${mkvPath}`);

  const proc = spawn('ffmpeg', ['-y', '-i', tsPath, '-c', 'copy', '-f', 'matroska', mkvPath], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderrTail = '';
  proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-2000); });

  proc.on('close', (code) => {
    if (code === 0 && fs.existsSync(mkvPath) && fs.statSync(mkvPath).size > 0) {
      fs.unlink(tsPath, () => {});
      db.prepare(`UPDATE recordings SET filename=? WHERE id=?`).run(mkvFilename, row.id);
      console.log(`[recorder] #${row.id} remux complete, removed source .ts`);
    } else {
      // remux failed - keep the original .ts, it's still a perfectly valid
      // recording, just not repackaged. Don't touch status/filename.
      console.warn(`[recorder] #${row.id} remux to .mkv failed (code ${code}) - keeping the .ts file as-is. ${stderrTail.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
      fs.unlink(mkvPath, () => {}); // clean up any partial .mkv leftover
    }
  });
  proc.on('error', (err) => {
    console.warn(`[recorder] #${row.id} could not start remux ffmpeg: ${err.message} - keeping the .ts file as-is.`);
  });
}

function startRecording(row) {
  if (activeProcs.has(row.id)) return;

  const format = recordFormat(row.user_id);
  // "mkv_post" records as .ts throughout (so it stays watchable while still
  // recording, unlike a growing/unfinalized .mkv), then gets remuxed to a
  // proper finished .mkv once the recording completes.
  const recordAsTs = format === 'ts' || format === 'mkv_post';
  const ext = recordAsTs ? 'ts' : 'mkv';
  const muxer = recordAsTs ? 'mpegts' : 'matroska';
  const filename = buildFilename(row, ext);
  const outputPath = path.join(userRecordingsDir(row.user_id), filename);
  const durationSec = Math.max(1, Math.round((row.rec_end - Date.now()) / 1000));

  let streamPath;
  try {
    streamPath = buildStreamEntryPath(row.user_id, row.channel_id);
  } catch (err) {
    console.error(`[recorder] #${row.id} could not resolve stream: ${err.message}`);
    db.prepare(`UPDATE recordings SET status='failed', error=? WHERE id=?`).run(err.message, row.id);
    notifier.notifyRecordingFailed(row.user_id, row.program_title, err.message);
    return;
  }
  const streamUrl = `http://127.0.0.1:${PORT}${streamPath}`;

  console.log(`[recorder] starting recording #${row.id} (user ${row.user_id}) "${row.program_title}" -> ${outputPath} (${durationSec}s, ${muxer})`);

  const args = [
    '-y',
    // tolerate brief network drop-outs/buffering instead of failing outright -
    // reconnect automatically rather than treating a momentary hiccup as fatal
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-allowed_extensions', 'ALL', // belt-and-suspenders: proxy URLs now carry real extensions,
                                  // but some providers use segment extensions outside ffmpeg's
                                  // built-in whitelist (e.g. unusual fMP4 naming) - this avoids
                                  // that whole class of "not in allowed_segment_extensions" failures
    '-fflags', '+genpts+discardcorrupt', // regenerate timestamps if missing/broken, and drop
                                          // individually corrupt packets instead of aborting -
                                          // live TV streams routinely have minor irregularities
                                          // that a stricter muxer (esp. Matroska's trailer/index)
                                          // would otherwise choke on
    '-i', streamUrl,
    '-c', 'copy', // always stream copy - never re-encode, regardless of container
    '-max_muxing_queue_size', '4096', // avoids "too many packets buffered" aborts when input
                                       // timing is irregular, common with live stream copy
    '-avoid_negative_ts', 'make_zero',
    '-f', muxer,
    '-t', String(durationSec),
    outputPath,
  ];

  let proc;
  try {
    proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    console.error(`[recorder] #${row.id} failed to spawn ffmpeg:`, err.message);
    db.prepare(`UPDATE recordings SET status='failed', error=? WHERE id=?`).run('Could not start ffmpeg: ' + err.message, row.id);
    notifier.notifyRecordingFailed(row.user_id, row.program_title, 'Could not start ffmpeg: ' + err.message);
    return;
  }

  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  db.prepare(`UPDATE recordings SET status='recording', filename=? WHERE id=?`).run(filename, row.id);
  activeProcs.set(row.id, { proc });
  notifier.notifyRecordingStarted(row.user_id, row.program_title);

  proc.on('close', (code) => {
    activeProcs.delete(row.id);
    const current = rowById(row.id);
    if (!current || current.status === 'cancelled') return; // cancelRecording already handled cleanup

    const size = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : -1;
    const tail = stderrTail.split('\n').filter(Boolean).slice(-8).join(' | ').trim();
    const diskFull = /no space left on device|ENOSPC/i.test(stderrTail);
    const MIN_USABLE_BYTES = 200 * 1024; // ~200KB - enough to exclude an immediate-failure stub,
                                          // small enough to still catch "recorded fine, hiccuped at the end"

    if (code === 0) {
      console.log(`[recorder] #${row.id} completed -> ${outputPath} (${size >= 0 ? size + ' bytes' : 'FILE NOT FOUND ON DISK'})`);
      if (size <= 0) {
        console.warn(`[recorder] #${row.id} ffmpeg exited 0 but the output file is missing or empty - check that RECORDINGS_PATH ("${BASE_RECORDINGS_DIR}") is actually writable and correctly volume-mounted.`);
      }
      db.prepare(`UPDATE recordings SET status='completed' WHERE id=?`).run(row.id);
      notifier.notifyRecordingCompleted(row.user_id, row.program_title);
      if (format === 'mkv_post' && size > 0) remuxToMkv(row, outputPath);
    } else if (!diskFull && size >= MIN_USABLE_BYTES) {
      // ffmpeg reported an error - often at finalization (writing the
      // trailer/seek index) - but a substantial amount of real video was
      // already written to disk. Treat this as completed-with-a-warning
      // rather than losing the recording outright; it's very likely still
      // playable, just possibly missing a proper seek index.
      const warnMsg = `Finished with a warning (ffmpeg exit code ${code}) after writing ${(size / 1024 / 1024).toFixed(1)}MB - the file is likely still playable, possibly with degraded seeking. ${tail}`;
      console.warn(`[recorder] #${row.id} finished with warnings (code ${code}) but kept a ${size}-byte file -> ${outputPath}`);
      db.prepare(`UPDATE recordings SET status='completed', error=? WHERE id=?`).run(warnMsg, row.id);
      notifier.notifyRecordingCompleted(row.user_id, row.program_title);
      if (format === 'mkv_post') remuxToMkv(row, outputPath);
    } else {
      const errMsg = diskFull
        ? `Recording failed: the recordings disk is full (no space left on device). Free up space on the RECORDINGS_PATH volume and try again.`
        : `ffmpeg exited with code ${code}: ${tail}`;
      console.error(`[recorder] #${row.id} failed (code ${code}, ${size} bytes written)`);
      db.prepare(`UPDATE recordings SET status='failed', error=? WHERE id=?`).run(errMsg, row.id);
      notifier.notifyRecordingFailed(row.user_id, row.program_title, errMsg);
    }
  });

  proc.on('error', (err) => {
    activeProcs.delete(row.id);
    db.prepare(`UPDATE recordings SET status='failed', error=? WHERE id=?`).run('ffmpeg error: ' + err.message, row.id);
    notifier.notifyRecordingFailed(row.user_id, row.program_title, 'ffmpeg error: ' + err.message);
  });
}

function cancelRecording(userId, id) {
  const row = ownedRowById(userId, id);
  if (!row) throw new Error('Recording not found');

  const active = activeProcs.get(id);
  if (active) {
    active.proc.kill('SIGTERM');
    activeProcs.delete(id);
  }

  db.prepare(`UPDATE recordings SET status='cancelled' WHERE id=?`).run(id);

  // best-effort cleanup of a partial/complete local file
  if (row.filename) {
    const p = path.join(userRecordingsDir(userId), row.filename);
    fs.unlink(p, () => {});
  }
}

function deleteRecording(userId, id) {
  const row = ownedRowById(userId, id);
  if (!row) throw new Error('Recording not found');
  if (activeProcs.has(id)) throw new Error('Recording is in progress - cancel it first.');
  if (row.filename) {
    const p = path.join(userRecordingsDir(userId), row.filename);
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

function getRecordingSettings(userId) {
  const { before, after } = padMinutes(userId);
  return {
    padBeforeMin: before,
    padAfterMin: after,
    recordingsPath: path.join(BASE_RECORDINGS_DIR, String(userId)),
    recordFormat: recordFormat(userId),
  };
}

function setRecordingSettings(userId, { padBeforeMin, padAfterMin, recordFormat: fmt }) {
  if (padBeforeMin !== undefined) setSetting(userId, 'record_pad_before_min', Math.max(0, Number(padBeforeMin) || 0));
  if (padAfterMin !== undefined) setSetting(userId, 'record_pad_after_min', Math.max(0, Number(padAfterMin) || 0));
  if (fmt !== undefined) setSetting(userId, 'record_format', ['ts', 'mkv', 'mkv_post'].includes(fmt) ? fmt : 'ts');
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
  BASE_RECORDINGS_DIR,
};
