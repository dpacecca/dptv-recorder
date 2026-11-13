// The default recording line (2.8.0).
//
// An admin can set one XC login that every recording uses, whoever scheduled
// it. Providers often allow one connection per line, so only one recording
// holds the default line at a time: a recording that starts while another is
// on it records with the login of the user who scheduled it instead (their
// own line, which their provider lets them watch on while it records). When
// two start together, the one scheduled first gets the default line.
//
// Channel IDs are the user's own (synced from their XC server). When the
// default line is on another server, its channel is found by EPG ID, then by
// name, in that line's own channel list; a channel it doesn't carry is
// recorded on the user's login.
//
// The password is never logged or sent back to the browser.

const { getSetting, getSystemSetting, setSystemSetting, db } = require('./db');
const xc = require('./xcClient');

const LIST_TTL_MS = 6 * 60 * 60 * 1000;

let holder = null; // id of the recording on the default line
let channelList = null; // { key, at, byEpg: Map, byName: Map }

function normalizeHost(host) {
  let h = String(host || '').trim();
  if (!h) return '';
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  return h.replace(/\/+$/, '').toLowerCase();
}

/** The default line, or null when none is set. */
function defaultLine() {
  const host = getSystemSetting('default_xc_host', '');
  const username = getSystemSetting('default_xc_username', '');
  const password = getSystemSetting('default_xc_password', '');
  return host && username && password ? { host, username, password } : null;
}

function describe() {
  const line = defaultLine();
  return {
    host: getSystemSetting('default_xc_host', ''),
    username: getSystemSetting('default_xc_username', ''),
    hasPassword: !!getSystemSetting('default_xc_password', ''),
    configured: !!line,
    inUseBy: holder,
  };
}

/** Saves the default line after checking it; a blank host turns it off. Blank password keeps the saved one. */
async function save({ host, username, password }) {
  const h = String(host || '').trim();
  if (!h) {
    setSystemSetting('default_xc_host', '');
    setSystemSetting('default_xc_username', '');
    setSystemSetting('default_xc_password', '');
    channelList = null;
    return;
  }
  const u = String(username || '').trim();
  const p = password ? String(password) : getSystemSetting('default_xc_password', '');
  if (!u || !p) throw new Error('Enter the username and password for the default line.');
  await xc.testAuth(h, u, p);
  setSystemSetting('default_xc_host', h);
  setSystemSetting('default_xc_username', u);
  setSystemSetting('default_xc_password', p);
  channelList = null;
}

/** Takes the default line for this recording when it is set and free. Synchronous, so start order decides. */
function claim(recordingId) {
  if (!defaultLine()) return false;
  if (holder !== null && holder !== recordingId) return false;
  holder = recordingId;
  return true;
}

function release(recordingId) {
  if (holder === recordingId) holder = null;
}

function holderId() {
  return holder;
}

function normName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function defaultChannels(line) {
  const key = `${normalizeHost(line.host)}|${line.username}`;
  if (channelList && channelList.key === key && Date.now() - channelList.at < LIST_TTL_MS) return channelList;
  const streams = await xc.getLiveStreams(line.host, line.username, line.password);
  const byEpg = new Map();
  const byName = new Map();
  for (const s of streams) {
    const id = String(s.stream_id);
    if (s.epg_channel_id && !byEpg.has(s.epg_channel_id)) byEpg.set(s.epg_channel_id, id);
    const n = normName(s.name);
    if (n && !byName.has(n)) byName.set(n, id);
  }
  channelList = { key, at: Date.now(), byEpg, byName };
  return channelList;
}

/**
 * The default line's login and the stream ID of this user's channel on it;
 * null when the channel isn't on that line.
 */
async function lineFor(userId, channelId) {
  const line = defaultLine();
  if (!line) return null;
  const channel = db.prepare('SELECT * FROM channels WHERE user_id = ? AND id = ?').get(userId, channelId);
  if (!channel) return null;
  if (normalizeHost(line.host) === normalizeHost(getSetting(userId, 'xc_host', ''))) {
    return { ...line, streamId: channel.id };
  }
  const list = await defaultChannels(line);
  const streamId = (channel.epg_channel_id && list.byEpg.get(channel.epg_channel_id)) || list.byName.get(normName(channel.name));
  return streamId ? { ...line, streamId } : null;
}

function resetForTests() {
  holder = null;
  channelList = null;
}

module.exports = { defaultLine, describe, save, claim, release, holderId, lineFor, resetForTests };
