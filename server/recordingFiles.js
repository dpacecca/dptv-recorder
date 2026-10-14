const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Short-lived, opaque links to a recording's file, for players that can't send
// an API key or cookie with every byte-range request (e.g. DPTV-Player's
// player). Same idea as the stream proxy tokens in hlsProxy.js: the token is
// the permission, it expires, and it reveals nothing about the account.
const tokenMap = new Map();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // long enough to watch a long recording with pauses

function makeFileToken(filePath) {
  const token = crypto.randomBytes(24).toString('hex');
  tokenMap.set(token, { filePath, expires: Date.now() + TOKEN_TTL_MS });
  return token;
}

function resolveFileToken(token) {
  const entry = tokenMap.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    tokenMap.delete(token);
    return null;
  }
  return entry.filePath;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tokenMap) if (v.expires < now) tokenMap.delete(k);
}, 10 * 60 * 1000).unref();

const CONTENT_TYPES = { '.ts': 'video/mp2t', '.mkv': 'video/x-matroska' };

// GET /api/recording-file/:token - serves the file with Range support (seeking),
// via Express's sendFile. Unauthenticated by design; the token is the auth.
function recordingFileHandler(req, res) {
  const filePath = resolveFileToken(req.params.token || '');
  if (!filePath || !fs.existsSync(filePath)) return res.status(404).send('not found or link expired');
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()];
  res.sendFile(filePath, {
    headers: type ? { 'Content-Type': type } : {},
    acceptRanges: true,
    cacheControl: false,
  });
}

module.exports = { makeFileToken, recordingFileHandler };
