const { db, getSetting } = require('./db');
const xc = require('./xcClient');
const { proxyPathFor } = require('./hlsProxy');

// Builds the local /api/hls/<token>.m3u8 path for a given user's channel,
// resolving their XC credentials and minting a fresh proxy token. Used both
// by the authenticated browser-facing /api/stream/:channelId route and
// directly (function call, no HTTP hop) by the recorder.
function buildStreamEntryPath(userId, channelId) {
  const host = getSetting(userId, 'xc_host');
  const username = getSetting(userId, 'xc_username');
  const password = getSetting(userId, 'xc_password');
  if (!host || !username || !password) {
    throw new Error('XC server not configured');
  }
  const channel = db.prepare('SELECT * FROM channels WHERE user_id = ? AND id = ?').get(userId, channelId);
  if (!channel) throw new Error('channel not found');

  const upstreamUrl = xc.liveStreamUrl(host, username, password, channel.id, 'm3u8');
  return proxyPathFor(upstreamUrl, 'm3u8');
}

module.exports = { buildStreamEntryPath };
