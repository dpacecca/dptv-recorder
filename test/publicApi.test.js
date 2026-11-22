// (2.10.6) API_PORT serves the player API and nothing else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { isPublicApiPath, publicApiHandler } = require('../server/publicApi');

test('the player paths are allowed, the web UI, login and admin API are not', () => {
  for (const p of ['/api/auth/dptv', '/api/recordings', '/api/recordings/12', '/api/recordings/12/stream',
    '/api/recording-file/abc123', '/api/timeshift', '/api/timeshift/x/stream', '/api/sync/status', '/api/version']) {
    assert.ok(isPublicApiPath(p), p);
  }
  for (const p of ['/', '/index.html', '/app.js', '/api/auth/login', '/api/auth/admin/users', '/api/auth/dptvx',
    '/api/settings', '/api/channels', '/api/recording-file/', '/api/recording-file/a/b', '/api/recordingsx', '/api/hls/x']) {
    assert.ok(!isPublicApiPath(p), p);
  }
});

test('the handler passes allowed requests to the app and answers 404 otherwise', async () => {
  const seen = [];
  const app = (req, res) => { seen.push(req.url); res.end('app'); };
  const server = http.createServer(publicApiHandler(app));
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  const get = (path) => new Promise((resolve) => http.get({ port, path }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }));
  assert.deepEqual(await get('/api/recordings?x=1'), { status: 200, body: 'app' });
  assert.equal((await get('/')).status, 404);
  assert.equal((await get('/api/auth/login')).status, 404);
  assert.deepEqual(seen, ['/api/recordings?x=1']);
  server.close();
});
