// Thin client for the Xtream Codes (XC) "player_api.php" JSON API and its
// companion xmltv.php / live stream endpoints.

// Many XC panels reject requests that don't carry a recognizable
// player User-Agent (a common anti-scraping/anti-leeching measure), and
// Node's fetch doesn't send a meaningful one by default. Mimic a common
// IPTV player so we don't get blocked at that layer.
const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

function normalizeHost(host) {
  let h = host.trim();
  if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
  return h.replace(/\/+$/, '');
}

function playerApiUrl(host, username, password, extraParams = {}) {
  const base = normalizeHost(host);
  const params = new URLSearchParams({ username, password, ...extraParams });
  return `${base}/player_api.php?${params.toString()}`;
}

async function fetchJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
    const bodyText = await res.text();

    if (!res.ok) {
      throw new Error(`XC server responded ${res.status} ${res.statusText}${bodyText ? ': ' + bodyText.slice(0, 200) : ''}`);
    }

    try {
      return JSON.parse(bodyText);
    } catch {
      // The server answered 200 OK but didn't send JSON - almost always means
      // the panel itself rejected the request (bad credentials, blocked UA,
      // wrong path, IP not whitelisted, etc.) and replied with a plain-text
      // message instead of the expected JSON payload.
      const snippet = bodyText.trim().slice(0, 200) || '(empty response)';
      throw new Error(`XC server did not return valid JSON - it replied: "${snippet}"`);
    }
  } finally {
    clearTimeout(t);
  }
}

async function testAuth(host, username, password) {
  const url = playerApiUrl(host, username, password);
  const data = await fetchJson(url);
  const status = data && data.user_info && data.user_info.auth;
  if (status !== 1) {
    const msg = (data && data.user_info && data.user_info.message) || 'Authentication failed - check your username/password.';
    throw new Error(msg);
  }
  return data.user_info;
}

async function getLiveCategories(host, username, password) {
  const url = playerApiUrl(host, username, password, { action: 'get_live_categories' });
  const data = await fetchJson(url);
  return Array.isArray(data) ? data : [];
}

async function getLiveStreams(host, username, password) {
  // no category_id => full channel list, each entry includes its category_id
  const url = playerApiUrl(host, username, password, { action: 'get_live_streams' });
  const data = await fetchJson(url);
  return Array.isArray(data) ? data : [];
}

function xmltvUrl(host, username, password) {
  const base = normalizeHost(host);
  const params = new URLSearchParams({ username, password });
  return `${base}/xmltv.php?${params.toString()}`;
}

async function fetchXmltv(host, username, password, timeoutMs = 120000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(xmltvUrl(host, username, password), {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok) throw new Error(`xmltv.php responded ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchXmltvUrl(url, username = '', password = '', timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'User-Agent': USER_AGENT };
    if (username || password) headers.Authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new Error(`EPG source responded ${res.status} ${res.statusText}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

function liveStreamUrl(host, username, password, streamId, ext = 'm3u8') {
  const base = normalizeHost(host);
  return `${base}/live/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${streamId}.${ext}`;
}

module.exports = {
  normalizeHost,
  testAuth,
  getLiveCategories,
  getLiveStreams,
  xmltvUrl,
  fetchXmltv,
  fetchXmltvUrl,
  liveStreamUrl,
  USER_AGENT,
};
