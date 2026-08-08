const crypto = require('crypto');

// Same UA used in xcClient.js - some panels block/serve differently based on
// User-Agent for the actual stream endpoints too, not just player_api.php.
const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

// Opaque token -> real upstream URL (which contains the XC username/password
// in its path). Tokens are short-lived and never expose credentials to the client.
const tokenMap = new Map();
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6h, plenty for a viewing session

function makeToken(url) {
  const token = crypto.randomBytes(16).toString('hex');
  tokenMap.set(token, { url, expires: Date.now() + TOKEN_TTL_MS });
  return token;
}

function resolveToken(token) {
  const entry = tokenMap.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    tokenMap.delete(token);
    return null;
  }
  return entry.url;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenMap) if (v.expires < now) tokenMap.delete(k);
}, 10 * 60 * 1000).unref();

// Rewrites an m3u8 playlist body so every referenced URI (variant playlist or
// segment) is resolved to an absolute upstream URL and replaced with an
// opaque /api/hls?u=<token> reference back through this proxy.
function rewritePlaylist(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    let absolute;
    try {
      absolute = new URL(trimmed, baseUrl).toString();
    } catch {
      return line;
    }
    const token = makeToken(absolute);
    return `/api/hls?u=${token}`;
  });
  return out.join('\n');
}

// Express handler: GET /api/hls?u=<token>
// First call for a channel uses a token seeded server-side (see routes.js);
// every subsequent nested reference uses a token minted by rewritePlaylist above.
async function hlsProxyHandler(req, res) {
  const token = req.query.u;
  if (!token) return res.status(400).send('missing token');
  const url = resolveToken(token);
  if (!url) return res.status(410).send('stream link expired, reselect the channel');

  try {
    const upstream = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      return res.status(upstream.status).send(`upstream error (${upstream.status})${body ? ': ' + body.slice(0, 200) : ''}`);
    }

    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist =
      contentType.includes('mpegurl') || url.endsWith('.m3u8') || contentType.includes('vnd.apple');

    if (isPlaylist) {
      const text = await upstream.text();
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(rewritePlaylist(text, url));
    }

    // binary segment (.ts / .aac / etc) - stream through as-is
    res.setHeader('Content-Type', contentType || 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.send(buf);
  } catch (err) {
    return res.status(502).send('proxy error: ' + err.message);
  }
}

module.exports = { makeToken, hlsProxyHandler };
