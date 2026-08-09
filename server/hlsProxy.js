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

// Pulls a real file extension off a URL's path (ignoring query strings), so
// our proxy URLs can carry the same extension the upstream URL had. ffmpeg's
// HLS demuxer (and possibly hls.js in some cases) validates segment URLs
// against a whitelist of recognized extensions - an extension-less proxy URL
// like "/api/hls?u=abc123" gets flatly rejected ("not in
// allowed_segment_extensions"), even though the actual bytes are fine.
function extractExt(url, fallback) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() || '';
    const m = last.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (m) return m[1].toLowerCase();
  } catch {
    // fall through to fallback
  }
  return fallback;
}

function proxyPathFor(url, fallbackExt) {
  const token = makeToken(url);
  const ext = extractExt(url, fallbackExt);
  return `/api/hls/${token}.${ext}`;
}

// Rewrites an m3u8 playlist body so every referenced URI (variant playlist,
// segment, encryption key, init segment, alternate audio/subtitle track) is
// resolved to an absolute upstream URL and replaced with an opaque
// /api/hls/<token>.<ext> reference back through this proxy - preserving the
// real extension so downstream players/ffmpeg don't reject it.
function rewriteUri(uri, baseUrl, fallbackExt) {
  let absolute;
  try {
    absolute = new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
  return proxyPathFor(absolute, fallbackExt);
}

function rewritePlaylist(body, baseUrl) {
  const lines = body.split(/\r?\n/);
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      // Tag lines can carry their own URI="..." attribute - e.g.
      // #EXT-X-KEY:METHOD=AES-128,URI="...",  #EXT-X-MAP:URI="init.mp4",
      // #EXT-X-MEDIA:TYPE=AUDIO,URI="audio.m3u8". Leaving these unrewritten
      // means the browser/ffmpeg tries to fetch them directly from the XC
      // server (credentials embedded in the path, and blocked by CORS in a
      // browser context) instead of through this proxy.
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        const path = rewriteUri(uri, baseUrl, 'key');
        return path ? `URI="${path}"` : match;
      });
    }

    const path = rewriteUri(trimmed, baseUrl, 'ts');
    return path || line;
  });
  return out.join('\n');
}

// Express handler: GET /api/hls/:tokenExt where tokenExt is "<token>.<ext>"
// (the extension is cosmetic/for whitelist purposes only - only the token
// portion is actually used to resolve the real upstream URL).
async function hlsProxyHandler(req, res) {
  const tokenExt = req.params.tokenExt || '';
  const token = tokenExt.includes('.') ? tokenExt.slice(0, tokenExt.lastIndexOf('.')) : tokenExt;
  if (!token) return res.status(400).send('missing token');
  const url = resolveToken(token);
  if (!url) return res.status(410).send('stream link expired, reselect the channel');

  try {
    const upstream = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      return res.status(upstream.status).send(`upstream error (${upstream.status})${body ? ': ' + body.slice(0, 200) : ''}`);
    }

    // IMPORTANT: many XC panels redirect the initial request to a completely
    // different edge/CDN URL (different domain, different session tokens,
    // sometimes even a different-looking "channel id"). fetch() follows that
    // redirect automatically, but any *relative* URLs inside the playlist we
    // just got need to be resolved against where the content actually came
    // from (upstream.url) - NOT the URL we originally requested. Using the
    // wrong base here silently constructs nonsense hybrid URLs that the
    // panel correctly rejects as invalid.
    const finalUrl = upstream.url || url;

    const buf = Buffer.from(await upstream.arrayBuffer());

    // Content-sniff rather than trust headers/extensions - some panels send
    // playlists with a generic or missing Content-Type, which would silently
    // break detection if we relied on that alone.
    const looksLikePlaylist = buf.slice(0, 7).toString('utf8') === '#EXTM3U';

    if (looksLikePlaylist) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(rewritePlaylist(buf.toString('utf8'), finalUrl));
    }

    // binary segment (.ts / .aac / etc) - stream through as-is
    const contentType = upstream.headers.get('content-type') || '';
    res.setHeader('Content-Type', contentType || 'video/mp2t');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buf);
  } catch (err) {
    return res.status(502).send('proxy error: ' + err.message);
  }
}

module.exports = { makeToken, proxyPathFor, hlsProxyHandler };
