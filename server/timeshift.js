// Live pause and rewind for DPTV-Player (v2.6.0).
//
// A player on a device with no storage of its own (a Chromecast) asks the server to keep the
// channel it is watching: ffmpeg copies the live stream into short MPEG-TS pieces here, the
// oldest dropped once they fall out of the rewind window, and the player reads the pieces back
// from any point - paused, rewound, or at the live edge. The server is then the only connection
// to the provider: the player never opens the channel itself while this runs.
//
// One buffer per user at a time (a new channel replaces the old), and a buffer nobody has asked
// about for IDLE_MS stops by itself, so a player that vanished never keeps a channel downloading.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { buildStreamEntryPath } = require('./streamEntry');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(process.env.RECORDINGS_PATH || '/recordings', '.timeshift');
const PIECE_SEC = 2;           // ffmpeg cuts at the first keyframe after this
const IDLE_MS = 90 * 1000;     // no state poll and no reader for this long: stop
const FAST_FAIL_MS = 20 * 1000;
const RESTART_DELAY_MS = 3000;
const MAX_WINDOW_MIN = 180;
const POLL_MS = 400;

const sessions = new Map(); // id -> session
const byUser = new Map();   // userId -> id

function cleanRoot() {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* nothing left from a previous run */ }
}

function start(userId, channelId, windowMinutes) {
  const previous = byUser.get(userId);
  if (previous) stop(previous);

  const id = crypto.randomBytes(16).toString('hex');
  const dir = path.join(ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const session = {
    id,
    userId,
    channelId: String(channelId),
    dir,
    windowMs: Math.min(Math.max(Number(windowMinutes) || 60, 5), MAX_WINDOW_MIN) * 60000,
    pieces: [],        // { file, start, dur, gapBefore }
    proc: null,
    run: 0,
    ext: 'ts',         // the channel's continuous .ts entry first; the HLS entry if that fails at once
    switched: false,
    closed: false,
    error: null,
    readers: 0,
    touchedAt: Date.now(),
  };
  sessions.set(id, session);
  byUser.set(userId, id);
  launch(session);
  session.idleTimer = setInterval(() => {
    if (session.readers === 0 && Date.now() - session.touchedAt > IDLE_MS) {
      console.log(`[timeshift] ${id.slice(0, 8)} idle - stopping`);
      stop(id);
    }
  }, 15000);
  console.log(`[timeshift] ${id.slice(0, 8)} channel ${session.channelId} for user ${userId}, ${session.windowMs / 60000} min`);
  return session;
}

function launch(session) {
  if (session.closed) return;
  let entry;
  try {
    entry = `http://127.0.0.1:${PORT}${buildStreamEntryPath(session.userId, session.channelId, session.ext)}`;
  } catch (err) {
    session.error = err.message;
    stop(session.id);
    return;
  }
  const run = ++session.run;
  const list = path.join(session.dir, `r${run}.csv`);
  const args = [
    '-y', '-loglevel', 'error',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    ...(session.ext === 'm3u8' ? ['-allowed_extensions', 'ALL'] : []),
    '-fflags', '+genpts+discardcorrupt',
    '-i', entry,
    '-map', '0', '-c', 'copy',
    '-max_muxing_queue_size', '4096',
    '-f', 'segment', '-segment_format', 'mpegts', '-segment_time', String(PIECE_SEC),
    '-segment_list', list, '-segment_list_type', 'csv', '-segment_list_flags', '+live',
    path.join(session.dir, `r${run}_%08d.ts`),
  ];
  const startedAt = Date.now();
  let proc;
  try {
    proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    session.error = 'Could not start ffmpeg: ' + err.message;
    stop(session.id);
    return;
  }
  session.proc = proc;
  let stderrTail = '';
  proc.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-2000); });

  // The csv gains a line as each piece is finished: "<file>,<start s>,<end s>". The first line of a run
  // anchors its stream time to the wall clock; a run after a reconnect starts after a gap.
  let read = 0;
  let anchor = null;
  let gapPending = session.pieces.length > 0;
  const watcher = setInterval(() => {
    let text;
    try { text = fs.readFileSync(list, 'utf8'); } catch (_) { return; }
    if (text.length <= read) return;
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < read) return;
    const lines = text.slice(read, lastNl).split('\n').filter(Boolean);
    read = lastNl + 1;
    for (const line of lines) {
      const [file, s, e] = line.split(',');
      const startSec = Number(s);
      const endSec = Number(e);
      if (!file || !Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
      if (anchor === null) anchor = Date.now() - endSec * 1000;
      const prev = session.pieces[session.pieces.length - 1];
      let pieceStart = Math.round(anchor + startSec * 1000);
      // A piece never starts before the previous one ended (ffmpeg's first cut can overlap a burst).
      if (prev && pieceStart < prev.start + prev.dur) pieceStart = prev.start + prev.dur;
      session.pieces.push({
        file: path.join(session.dir, file),
        start: pieceStart,
        dur: Math.max(1, Math.round((endSec - startSec) * 1000)),
        gapBefore: gapPending,
      });
      gapPending = false;
    }
    trim(session);
  }, POLL_MS);

  proc.on('close', (code) => {
    clearInterval(watcher);
    if (session.proc === proc) session.proc = null;
    if (session.closed) return;
    const fast = Date.now() - startedAt < FAST_FAIL_MS && anchor === null;
    if (fast && !session.switched) {
      session.switched = true;
      session.ext = session.ext === 'ts' ? 'm3u8' : 'ts';
      console.warn(`[timeshift] ${session.id.slice(0, 8)} the ${session.ext === 'm3u8' ? '.ts' : 'HLS'} entry failed at once (code ${code}) - trying the other`);
      launch(session);
      return;
    }
    if (fast && session.pieces.length === 0) {
      session.error = stderrTail.trim().split('\n').pop() || `ffmpeg exited with code ${code}`;
      console.warn(`[timeshift] ${session.id.slice(0, 8)} could not start: ${session.error}`);
      stop(session.id);
      return;
    }
    console.warn(`[timeshift] ${session.id.slice(0, 8)} ffmpeg exited (code ${code}) - reconnecting`);
    setTimeout(() => launch(session), RESTART_DELAY_MS);
  });
}

function trim(session) {
  const oldestKept = Date.now() - session.windowMs;
  while (session.pieces.length > 1 && session.pieces[0].start + session.pieces[0].dur < oldestKept) {
    const old = session.pieces.shift();
    fs.rm(old.file, { force: true }, () => {});
  }
}

function stop(id) {
  const session = sessions.get(id);
  if (!session) return;
  session.closed = true;
  sessions.delete(id);
  if (byUser.get(session.userId) === id) byUser.delete(session.userId);
  clearInterval(session.idleTimer);
  if (session.proc) { try { session.proc.kill('SIGTERM'); } catch (_) { /* already gone */ } }
  // Readers still open get to the end of what they have; the folder goes once they let go.
  setTimeout(() => fs.rm(session.dir, { recursive: true, force: true }, () => {}), 5000);
}

function owned(userId, id) {
  const session = sessions.get(id);
  return session && session.userId === userId ? session : null;
}

function state(session) {
  session.touchedAt = Date.now();
  return {
    id: session.id,
    channelId: session.channelId,
    now: Date.now(), // the player moves piece times onto its own clock with this
    closed: session.closed,
    error: session.error,
    windowMs: session.windowMs,
    pieces: session.pieces.map((p) => [p.start, p.dur, p.gapBefore ? 1 : 0]),
  };
}

// The pieces from the one holding `fromMs` (the newest when null), then each new one as it is
// finished, until the client goes or the buffer stops. A piece already dropped starts at the oldest.
async function stream(session, fromMs, req, res) {
  session.touchedAt = Date.now();
  session.readers++;
  let gone = false;
  req.on('close', () => { gone = true; });
  res.on('error', () => { gone = true; });
  res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Cache-Control': 'no-cache' });
  const pickFirst = () => {
    const list = session.pieces;
    if (list.length === 0) return null;
    if (fromMs == null) return list[list.length - 1];
    let found = list[0];
    for (const p of list) { if (p.start <= fromMs) found = p; else break; }
    return found;
  };
  try {
    let current = null;
    while (!gone && !session.closed && !(current = pickFirst())) await sleep(POLL_MS);
    while (!gone && current) {
      session.touchedAt = Date.now();
      await pipeFile(current.file, res, () => gone);
      if (gone) break;
      // The next piece: the first that starts after this one (pieces are in order).
      let next = null;
      while (!gone && !session.closed) {
        next = session.pieces.find((p) => p.start > current.start) || null;
        if (next) break;
        await sleep(POLL_MS);
      }
      if (!next) break;
      current = next;
    }
  } catch (_) {
    // a client that closes mid-piece (a seek, a zap) ends here: normal
  } finally {
    session.readers--;
    session.touchedAt = Date.now();
    if (!res.writableEnded) res.end();
  }
}

function pipeFile(file, res, isGone) {
  return new Promise((resolve) => {
    const input = fs.createReadStream(file);
    input.on('error', () => resolve()); // dropped under us: skip it
    input.on('data', (chunk) => {
      if (isGone()) { input.destroy(); resolve(); return; }
      if (!res.write(chunk)) {
        input.pause();
        res.once('drain', () => input.resume());
      }
    });
    input.on('end', resolve);
    input.on('close', resolve);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { cleanRoot, start, stop, owned, state, stream };
