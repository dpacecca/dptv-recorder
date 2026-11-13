// The default recording line: run with `npm test`.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dptv-rec-line-'));
process.env.DB_PATH = path.join(tmp, 'guide.db');

const { db, setSetting, setSystemSetting } = require('../server/db');
const auth = require('../server/auth');
const line = require('../server/recordingLine');

// A provider whose default line carries the channels under other IDs.
let listCalls = 0;
const provider = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  if (url.searchParams.get('username') !== 'rec' || url.searchParams.get('password') !== 'rec-pw') {
    return res.end(JSON.stringify({ user_info: { auth: 0 } }));
  }
  if (url.searchParams.get('action') === 'get_live_streams') {
    listCalls += 1;
    return res.end(JSON.stringify([
      { stream_id: 900, name: 'Sky Sport 1 HD', epg_channel_id: 'sky1.nz' },
      { stream_id: 901, name: 'TVNZ 1', epg_channel_id: '' },
    ]));
  }
  res.end(JSON.stringify({ user_info: { auth: 1 } }));
});

let base;
let alice;
before(async () => {
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${provider.address().port}`;
  alice = auth.createUser({ username: 'alice', password: 'secret123', firstName: 'A', lastName: 'L', email: 'a@x' });
  setSetting(alice.id, 'xc_host', 'http://dptv-server:8000');
  const add = db.prepare('INSERT INTO channels (user_id, id, name, epg_channel_id) VALUES (?, ?, ?, ?)');
  add.run(alice.id, '7', 'Sky Sport 1', 'sky1.nz');
  add.run(alice.id, '8', 'TVNZ 1', '');
  add.run(alice.id, '9', 'Only On DPTV', '');
});

after(() => {
  provider.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => line.resetForTests());

test('off until set: nobody gets the default line', () => {
  assert.equal(line.claim(1), false);
});

test('saving checks the login, keeps the password out of what is shown', async () => {
  await assert.rejects(line.save({ host: base, username: 'rec', password: 'wrong' }));
  await line.save({ host: base, username: 'rec', password: 'rec-pw' });
  const shown = line.describe();
  assert.equal(shown.configured, true);
  assert.equal(shown.hasPassword, true);
  assert.ok(!JSON.stringify(shown).includes('rec-pw'));
  // A blank password keeps the saved one.
  await line.save({ host: base, username: 'rec', password: '' });
  assert.equal(line.describe().configured, true);
});

test('one recording at a time: the first to start holds it, the next uses its own login', () => {
  assert.equal(line.claim(1), true);
  assert.equal(line.claim(2), false);
  line.release(2); // releasing a line it never held changes nothing
  assert.equal(line.holderId(), 1);
  line.release(1);
  assert.equal(line.claim(2), true);
});

test("the user's channel is found on the default line by EPG ID, then by name", async () => {
  const sky = await line.lineFor(alice.id, '7');
  assert.equal(sky.streamId, '900');
  assert.equal(sky.username, 'rec');
  assert.equal((await line.lineFor(alice.id, '8')).streamId, '901');
  assert.equal(await line.lineFor(alice.id, '9'), null);
  assert.equal(listCalls, 1, 'the line\'s channel list is read once, then kept');
});

test('on the same server the channel keeps its ID, with no list to read', async () => {
  setSetting(alice.id, 'xc_host', base + '/');
  const before = listCalls;
  assert.equal((await line.lineFor(alice.id, '9')).streamId, '9');
  assert.equal(listCalls, before);
  setSetting(alice.id, 'xc_host', 'http://dptv-server:8000');
});

test('a blank server turns it off', async () => {
  await line.save({ host: '' });
  assert.equal(line.describe().configured, false);
  assert.equal(line.claim(5), false);
  setSystemSetting('default_xc_host', '');
});
