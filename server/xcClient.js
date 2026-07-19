// Thin client for the Xtream Codes (XC) "player_api.php" JSON API and its
// companion xmltv.php / live stream endpoints.

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
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`XC server responded ${res.status} ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function testAuth(host, username, password) {
  const url = playerApiUrl(host, username, password);
  const data = await fetchJson(url);
  const status = data && data.user_info && data.user_info.auth;
  if (status !== 1) {
    const msg = (data && data.user_info && data.user_info.message) || 'Authentication failed';
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
    const res = await fetch(xmltvUrl(host, username, password), { signal: controller.signal });
    if (!res.ok) throw new Error(`xmltv.php responded ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
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
  liveStreamUrl,
};
