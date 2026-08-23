const { db, getSetting } = require('./db');
const xc = require('./xcClient');
const { proxyPathFor, tsProxyPathFor } = require('./hlsProxy');

// Builds a local proxy path for a given user's channel, resolving their XC
// credentials and minting a fresh proxy token. Used both by the
// authenticated browser-facing /api/stream/:channelId route and directly
// (function call, no HTTP hop) by the recorder.
//
// ext='m3u8' (the default, and what the recorder always uses) goes through
// the chunked-HLS proxy (/api/hls/<token>.m3u8) - segments and playlists,
// rewritten and reissued as they're fetched.
// ext='ts' goes through the raw continuous-stream proxy (/api/live-ts/<token>)
// instead - one persistent connection, piped straight through, with no
// manifest to go stale or need reconnecting.
function buildStreamEntryPath(userId, channelId, ext = 'm3u8') {
  const host = getSetting(userId, 'xc_host');
  const username = getSetting(userId, 'xc_username');
  const password = getSetting(userId, 'xc_password');
  if (!host || !username || !password) {
    throw new Error('XC server not configured');
  }
  const channel = db.prepare('SELECT * FROM channels WHERE user_id = ? AND id = ?').get(userId, channelId);
  if (!channel) throw new Error('channel not found');

  const upstreamUrl = xc.liveStreamUrl(host, username, password, channel.id, ext);
  return ext === 'ts' ? tsProxyPathFor(upstreamUrl) : proxyPathFor(upstreamUrl, ext);
}

module.exports = { buildStreamEntryPath };
