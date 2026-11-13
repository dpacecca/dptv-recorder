// Sign-in with DPTV-Server: run with `npm test`.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dptv-rec-test-'));
process.env.DB_PATH = path.join(tmp, 'guide.db');
delete process.env.DPTV_SERVER_URL;

const express = require('express');
const cookieParser = require('cookie-parser');
const { db, getSetting, setSetting } = require('../server/db');
const auth = require('../server/auth');
const dptv = require('../server/dptvLink');
const authRoutes = require('../server/authRoutes');

// A stand-in DPTV-Server: player_api.php answers as DPTV-Server does (401 for a bad login).
const logins = new Map([['alice', 'pw-a'], ['bob', 'pw-b'], ['admin', 'pw-admin']]);
let server;
let base;
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const u = url.searchParams.get('username');
  const p = url.searchParams.get('password');
  if (url.pathname !== '/player_api.php') { res.writeHead(404); return res.end(); }
  if (!u || logins.get(u) !== p) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"detail":"Invalid credentials"}'); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (url.searchParams.get('action')) return res.end('[]');
  res.end(JSON.stringify({ user_info: { auth: 1, username: u }, server_info: {} }));
});

let app;
let appBase;
before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${fake.address().port}`;
  const a = express();
  a.set('trust proxy', 1);
  a.use(express.json());
  a.use(cookieParser());
  a.use('/api/auth', authRoutes);
  a.get('/api/whoami', auth.requireAuth, (req, res) => res.json({ username: req.user.username }));
  await new Promise((r) => { server = a.listen(0, '127.0.0.1', r); });
  appBase = `http://127.0.0.1:${server.address().port}`;
  app = a;
});

after(() => {
  server.close();
  fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  dptv.resetLimits();
  dptv.setServerUrl(base);
});

function signIn(body, headers = {}) {
  return fetch(`${appBase}/api/auth/dptv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('off until a DPTV-Server is trusted', async () => {
  dptv.setServerUrl('');
  const r = await signIn({ username: 'alice', password: 'pw-a', device: 'TV' });
  assert.equal(r.status, 404);
  const s = await (await fetch(`${appBase}/api/auth/dptv`)).json();
  assert.equal(s.enabled, false);
});

test('a first sign-in makes the account, points it at DPTV-Server and issues a working key', async () => {
  const r = await signIn({ username: 'alice', password: 'pw-a', device: 'Living room TV' });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.username, 'alice');
  assert.equal(out.created, true);
  assert.match(out.apiKey, /^dptv_/);
  const user = auth.findUserByUsername('alice');
  assert.equal(user.dptv_login, 'alice');
  assert.equal(user.is_admin, 0);
  assert.equal(getSetting(user.id, 'xc_host'), base);
  assert.equal(getSetting(user.id, 'xc_username'), 'alice');
  const who = await (await fetch(`${appBase}/api/whoami`, { headers: { Authorization: `Bearer ${out.apiKey}` } })).json();
  assert.equal(who.username, 'alice');
});

test('signing in again from the same device replaces its key; another device gets its own', async () => {
  const first = await (await signIn({ username: 'alice', password: 'pw-a', device: 'Phone' })).json();
  const again = await (await signIn({ username: 'alice', password: 'pw-a', device: 'Phone' })).json();
  assert.equal(again.created, false);
  const old = await fetch(`${appBase}/api/whoami`, { headers: { Authorization: `Bearer ${first.apiKey}` } });
  assert.equal(old.status, 401);
  await signIn({ username: 'alice', password: 'pw-a', device: 'Tablet' });
  const user = auth.findUserByUsername('alice');
  const names = auth.listApiKeys(user.id).map((k) => k.name).sort();
  assert.deepEqual(names, ['DPTV device: Living room TV', 'DPTV device: Phone', 'DPTV device: Tablet']);
});

test('a wrong password is refused and nothing is made', async () => {
  const r = await signIn({ username: 'nobody', password: 'x' });
  assert.equal(r.status, 401);
  assert.equal(auth.findUserByUsername('nobody'), undefined);
});

test('failed attempts are limited per login', async () => {
  for (let i = 0; i < dptv.MAX_FAILS_PER_LOGIN; i += 1) {
    assert.equal((await signIn({ username: 'bob', password: 'wrong' })).status, 401);
  }
  const blocked = await signIn({ username: 'bob', password: 'pw-b' });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
});

test('failed attempts are limited per address across logins', async () => {
  let last;
  for (let i = 0; i < 21; i += 1) last = await signIn({ username: `guess${i}`, password: 'x' });
  assert.equal(last.status, 429);
  const other = await signIn({ username: 'bob', password: 'pw-b' }, { 'X-Forwarded-For': '10.9.9.9' });
  assert.equal(other.status, 200);
});

test('an existing account with the same name is linked, keeping its own provider', async () => {
  dptv.resetLimits();
  const carol = auth.createUser({ username: 'carol', password: 'secret123', firstName: 'C', lastName: 'L', email: 'c@x' });
  setSetting(carol.id, 'xc_host', 'http://provider.example');
  setSetting(carol.id, 'xc_username', 'carol-line');
  setSetting(carol.id, 'xc_password', 'line-pw');
  logins.set('carol', 'pw-c');
  const out = await (await signIn({ username: 'carol', password: 'pw-c', device: 'TV' })).json();
  assert.equal(out.username, 'carol');
  assert.equal(out.created, false);
  assert.equal(out.providerSet, false);
  assert.equal(auth.findUserById(carol.id).dptv_login, 'carol');
  assert.equal(getSetting(carol.id, 'xc_host'), 'http://provider.example');
});

test('an admin account is never taken over by name; an admin link is honoured', async () => {
  const admin = auth.createUser({ username: 'admin', password: 'secret123', firstName: 'A', lastName: 'U', email: 'admin@x', isAdmin: true });
  const out = await (await signIn({ username: 'admin', password: 'pw-admin', device: 'TV' })).json();
  assert.notEqual(out.username, 'admin');
  assert.equal(out.created, true);
  // The admin links the login to their own account instead: the made one gives it up first.
  const made = auth.findUserByUsername(out.username);
  assert.throws(() => dptv.linkAccount(admin.id, 'admin'), /already linked/);
  dptv.linkAccount(made.id, '');
  assert.equal(auth.listApiKeys(made.id).length, 0);
  dptv.linkAccount(admin.id, 'admin');
  const again = await (await signIn({ username: 'admin', password: 'pw-admin', device: 'TV' })).json();
  assert.equal(again.username, 'admin');
});

test('keys are withdrawn once DPTV-Server stops accepting the login', async () => {
  logins.set('dave', 'pw-d');
  const out = await (await signIn({ username: 'dave', password: 'pw-d', device: 'TV' })).json();
  assert.equal(await dptv.recheckIssuedKeys(), 0);
  logins.delete('dave');
  assert.equal(await dptv.recheckIssuedKeys(), 1);
  const r = await fetch(`${appBase}/api/whoami`, { headers: { Authorization: `Bearer ${out.apiKey}` } });
  assert.equal(r.status, 401);
});

test('nothing is withdrawn while DPTV-Server cannot be reached', async () => {
  logins.set('erin', 'pw-e');
  await signIn({ username: 'erin', password: 'pw-e', device: 'TV' });
  const erin = auth.findUserByUsername('erin');
  dptv.setServerUrl('http://127.0.0.1:1');
  setSetting(erin.id, 'xc_host', 'http://127.0.0.1:1');
  assert.equal(await dptv.recheckIssuedKeys(), 0);
  assert.equal(auth.listApiKeys(erin.id).length, 1);
});

test('the password is never logged', async () => {
  const lines = [];
  const orig = [console.log, console.warn, console.error];
  console.log = console.warn = console.error = (...a) => lines.push(a.join(' '));
  try {
    logins.set('frank', 'very-secret-pw');
    await signIn({ username: 'frank', password: 'very-secret-pw', device: 'TV' });
    await signIn({ username: 'frank', password: 'wrong-secret-pw', device: 'TV' });
  } finally {
    [console.log, console.warn, console.error] = orig;
  }
  assert.ok(!lines.some((l) => l.includes('secret-pw')));
});

test('admin setting accepts only a DPTV-Server', async () => {
  const admin = auth.findUserByUsername('admin');
  const token = auth.createSession(admin.id);
  const post = (serverUrl) => fetch(`${appBase}/api/auth/admin/dptv-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${auth.SESSION_COOKIE}=${token}` },
    body: JSON.stringify({ serverUrl }),
  });
  assert.equal((await post('http://127.0.0.1:1')).status, 400);
  const ok = await post(base + '/');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).serverUrl, base);
  void db;
  void app;
});
