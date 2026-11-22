// (2.10.4) Live .mkv recordings: "mkv" now records as .ts and remuxes at the end, and a finished .mkv
// left without its index by an interrupted ffmpeg is remuxed once at start-up.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dptv-rec-mkv-'));
process.env.DB_PATH = path.join(tmp, 'guide.db');
process.env.RECORDINGS_PATH = path.join(tmp, 'recordings');

const { db, getSetting, setSetting } = require('../server/db');
const auth = require('../server/auth');
const recorder = require('../server/recorder');

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const duration = (file) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).stdout.toString().trim());

let user;
before(() => {
  user = auth.createUser({ username: 'bob', password: 'secret123', firstName: 'B', lastName: 'O', email: 'b@x' });
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the live .mkv format records as .ts and remuxes at the end', () => {
  setSetting(user.id, 'record_format', 'mkv');
  assert.equal(recorder.getRecordingSettings(user.id).recordFormat, 'mkv_post');
  recorder.setRecordingSettings(user.id, { recordFormat: 'mkv' });
  assert.equal(getSetting(user.id, 'record_format', ''), 'mkv_post');
});

test('a cut-off .mkv is remuxed once to its real length; a checked one is left alone', { skip: !hasFfmpeg && 'no ffmpeg' }, async () => {
  const dir = path.join(process.env.RECORDINGS_PATH, String(user.id));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'show.mkv');
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=f=440',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '20', '-f', 'matroska', file]);
  assert.equal(made.status, 0);
  // Cut it off as an interrupted ffmpeg would: the header still says 20 s.
  fs.truncateSync(file, Math.floor(fs.statSync(file).size * 0.4));
  assert.ok(duration(file) >= 19, 'the header still claims the full length');

  const now = Date.now();
  const id = db.prepare(`INSERT INTO recordings (user_id, channel_id, channel_name, program_title, program_start, program_stop,
    rec_start, rec_end, status, filename, created_at) VALUES (?, 'c', 'C', 'Show', ?, ?, ?, ?, 'completed', 'show.mkv', ?)`)
    .run(user.id, now - 60000, now, now - 60000, now, now).lastInsertRowid;

  await recorder.repairUnfinishedMkvs();
  const repaired = duration(file);
  assert.ok(repaired > 0 && repaired < 15, `remuxed to its real length, got ${repaired}`);
  assert.equal(getSetting(user.id, `mkv_checked_${id}`, ''), '1');

  const mtime = fs.statSync(file).mtimeMs;
  await recorder.repairUnfinishedMkvs();
  assert.equal(fs.statSync(file).mtimeMs, mtime, 'checked once, not again');
});

test('the recorder-wide default format applies to users without their own, and can be applied to all', () => {
  const carol = auth.createUser({ username: 'carol', password: 'secret123', firstName: 'C', lastName: 'A', email: 'c@x' });
  assert.equal(recorder.getRecordingSettings(carol.id).recordFormat, 'ts', 'TS until an admin picks otherwise');
  assert.equal(recorder.setDefaultRecordFormat('mkv_post', false), 'mkv_post');
  assert.equal(recorder.getRecordingSettings(carol.id).recordFormat, 'mkv_post', 'no choice of her own: the default');
  setSetting(user.id, 'record_format', 'ts');
  assert.equal(recorder.getRecordingSettings(user.id).recordFormat, 'ts', 'his own choice wins');
  recorder.setDefaultRecordFormat('mkv_post', true);
  assert.equal(recorder.getRecordingSettings(user.id).recordFormat, 'mkv_post', 'applied to everyone');
  assert.equal(recorder.setDefaultRecordFormat('bogus', false), 'ts');
});
