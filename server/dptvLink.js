// Sign-in with DPTV-Server (2.7.0).
//
// When this recorder trusts a DPTV-Server, a player that knows a DPTV-Server
// (XC) login can get its own API key here without anyone typing one in:
// the login is checked against DPTV-Server's player_api.php, the recorder
// account it belongs to is found (or made, the first time), and a key for
// that device is issued.
//
// The login's password is never logged. It is kept only as the account's
// provider password, and only when the account records from DPTV-Server -
// the same as when someone types it into Settings - since recordings need it.

const auth = require('./auth');
const { db, getSetting, setSetting, getSystemSetting, setSystemSetting } = require('./db');

const SETTING_KEY = 'dptv_server_url';
const KEY_SOURCE = 'dptv';
const USER_AGENT = 'DPTV-Recorder';

// ---------------- the trusted DPTV-Server ----------------
function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u.replace(/\/+$/, '');
}

/** DPTV_SERVER_URL wins over the admin setting, so a container's config can't be changed from the web UI. */
function serverUrl() {
  return normalizeUrl(process.env.DPTV_SERVER_URL) || normalizeUrl(getSystemSetting(SETTING_KEY, ''));
}

function serverUrlFromEnv() {
  return !!normalizeUrl(process.env.DPTV_SERVER_URL);
}

function setServerUrl(url) {
  setSystemSetting(SETTING_KEY, normalizeUrl(url));
}

// ---------------- checking a login ----------------
/**
 * Asks DPTV-Server whether this login is good.
 * Returns 'ok' or 'refused' (DPTV-Server answered no: wrong password, disabled, expired);
 * throws when DPTV-Server could not be asked, which is not the login's fault.
 */
async function checkLogin(base, username, password, timeoutMs = 15000) {
  const params = new URLSearchParams({ username, password });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${base}/player_api.php?${params}`, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'error',
    });
  } catch {
    throw new Error('DPTV-Server could not be reached.');
  } finally {
    clearTimeout(t);
  }
  if (res.status === 401 || res.status === 403) return 'refused';
  if (!res.ok) throw new Error(`DPTV-Server answered ${res.status}.`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('DPTV-Server did not answer as expected.');
  }
  const info = data && data.user_info;
  if (!info) throw new Error('DPTV-Server did not answer as expected.');
  return Number(info.auth) === 1 ? 'ok' : 'refused';
}

// ---------------- failed-attempt limits ----------------
// Counted per address and per login, so one address can't guess many logins
// and many addresses can't take turns guessing one. Only failures count.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_LOGIN = 5;
const MAX_FAILS_PER_ADDRESS = 20;
const failures = new Map(); // key -> [timestamps]

function recent(key, now) {
  const list = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list); else failures.delete(key);
  return list;
}

/** Seconds until another attempt is allowed, or 0. */
function blockedFor(ip, login, now = Date.now()) {
  const checks = [[`ip:${ip}`, MAX_FAILS_PER_ADDRESS], [`login:${String(login).toLowerCase()}`, MAX_FAILS_PER_LOGIN]];
  let wait = 0;
  for (const [key, max] of checks) {
    const list = recent(key, now);
    if (list.length >= max) wait = Math.max(wait, Math.ceil((list[list.length - max] + WINDOW_MS - now) / 1000));
  }
  return wait;
}

function noteFailure(ip, login, now = Date.now()) {
  for (const key of [`ip:${ip}`, `login:${String(login).toLowerCase()}`]) {
    const list = recent(key, now);
    list.push(now);
    failures.set(key, list);
  }
}

function clearFailures(login) {
  failures.delete(`login:${String(login).toLowerCase()}`);
}

function resetLimits() {
  failures.clear();
}

setInterval(() => { const now = Date.now(); for (const key of [...failures.keys()]) recent(key, now); }, WINDOW_MS).unref();

// ---------------- finding the account ----------------
function freeUsername(wanted) {
  const base = String(wanted).replace(/\s+/g, '').slice(0, 60) || 'dptv';
  if (!auth.findUserByUsername(base)) return base;
  for (let i = 2; ; i += 1) {
    const name = `${base}-dptv${i === 2 ? '' : i}`;
    if (!auth.findUserByUsername(name)) return name;
  }
}

function freeEmail(username) {
  const local = username.toLowerCase().replace(/[^a-z0-9._-]/g, '_') || 'dptv';
  let email = `${local}@dptv.local`;
  for (let i = 2; auth.findUserByEmail(email); i += 1) email = `${local}.${i}@dptv.local`;
  return email;
}

/**
 * The recorder account for a DPTV-Server login:
 * 1. the account linked to it (on first sign-in, or by an admin);
 * 2. else a non-admin account with the same username and no link yet, which is then linked;
 * 3. else a new account, made now.
 * Admin accounts are never taken over by name: an admin links one in Admin, Users.
 */
function accountFor(login) {
  const linked = auth.findUserByDptvLogin(login);
  if (linked) return { user: linked, created: false };
  const sameName = auth.findUserByUsername(login);
  if (sameName && !sameName.is_admin && !sameName.dptv_login) {
    db.prepare('UPDATE users SET dptv_login = ? WHERE id = ?').run(login, sameName.id);
    return { user: auth.findUserById(sameName.id), created: false };
  }
  const username = freeUsername(login);
  const user = auth.createUser({
    username,
    password: null,
    firstName: login,
    lastName: '',
    email: freeEmail(username),
  });
  db.prepare('UPDATE users SET dptv_login = ? WHERE id = ?').run(login, user.id);
  return { user: auth.findUserById(user.id), created: true };
}

/** Admin: link an account to a DPTV-Server login (blank unlinks). */
function linkAccount(userId, login) {
  const user = auth.findUserById(userId);
  if (!user) throw new Error('User not found.');
  const value = String(login || '').trim();
  if (!value) {
    db.prepare('UPDATE users SET dptv_login = NULL WHERE id = ?').run(userId);
    revokeIssuedKeys(userId);
    return auth.findUserById(userId);
  }
  const other = auth.findUserByDptvLogin(value);
  if (other && other.id !== userId) throw new Error(`That DPTV-Server login is already linked to @${other.username}.`);
  if (user.dptv_login && user.dptv_login !== value) revokeIssuedKeys(userId);
  db.prepare('UPDATE users SET dptv_login = ? WHERE id = ?').run(value, userId);
  return auth.findUserById(userId);
}

// ---------------- the account's provider ----------------
/**
 * Points an account with no provider yet at DPTV-Server, with this login, and starts a channel sync.
 * An account already recording from DPTV-Server with this login gets the current password.
 * An account set up with another provider is left as it is.
 */
function useDptvServerAsProvider(userId, base, login, password) {
  const host = getSetting(userId, 'xc_host', '');
  const sameProvider = normalizeUrl(host) === base && getSetting(userId, 'xc_username', '') === login;
  if (host && !sameProvider) return false;
  const fresh = !host;
  setSetting(userId, 'xc_host', base);
  setSetting(userId, 'xc_username', login);
  setSetting(userId, 'xc_password', password);
  if (fresh) {
    const { performSync, scheduleAutoSync } = require('./sync');
    scheduleAutoSync(userId, getSetting(userId, 'auto_sync_hours', 4));
    performSync(userId).catch((err) => console.error(`[dptv] first sync for user ${userId} failed:`, err.message));
  }
  return true;
}

// ---------------- keys ----------------
function deviceKeyName(device) {
  const d = String(device || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60) || 'a device';
  return `DPTV device: ${d}`;
}

/** One key per device: signing in again from the same device replaces its key. */
function issueKey(userId, device) {
  const name = deviceKeyName(device);
  db.prepare('DELETE FROM api_keys WHERE user_id = ? AND source = ? AND name = ?').run(userId, KEY_SOURCE, name);
  return auth.createApiKey(userId, name, KEY_SOURCE);
}

function revokeIssuedKeys(userId) {
  return db.prepare('DELETE FROM api_keys WHERE user_id = ? AND source = ?').run(userId, KEY_SOURCE).changes;
}

// ---------------- the sign-in ----------------
class SignInError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function signIn({ username, password, device, ip }) {
  const base = serverUrl();
  if (!base) throw new SignInError(404, 'Sign-in with DPTV-Server is not turned on for this recorder.');
  const login = String(username || '').trim();
  if (!login || !password) throw new SignInError(400, 'Username and password are required.');
  const wait = blockedFor(ip, login);
  if (wait) throw new SignInError(429, 'Too many failed sign-ins. Try again later.', { retryAfter: wait });

  let verdict;
  try {
    verdict = await checkLogin(base, login, String(password));
  } catch (err) {
    throw new SignInError(502, err.message);
  }
  if (verdict !== 'ok') {
    noteFailure(ip, login);
    throw new SignInError(401, 'DPTV-Server did not accept that username and password.');
  }
  clearFailures(login);

  const { user, created } = accountFor(login);
  const provider = useDptvServerAsProvider(user.id, base, login, String(password));
  const { key } = issueKey(user.id, device);
  console.log(`[dptv] ${created ? 'created' : 'signed in'} @${user.username} from a DPTV device`);
  return { apiKey: key, username: user.username, created, providerSet: provider };
}

// ---------------- withdrawing keys from disabled logins ----------------
// Every few hours the logins behind issued keys are checked again with the
// password the account records with. One DPTV-Server refuses (the login was
// disabled, expired or its password changed) has that account's issued keys
// withdrawn; the device signs in again, or stops. If DPTV-Server can't be
// reached nothing is withdrawn.
async function recheckIssuedKeys() {
  const base = serverUrl();
  if (!base) return 0;
  const rows = db.prepare(`
    SELECT DISTINCT u.id, u.dptv_login FROM users u
    JOIN api_keys k ON k.user_id = u.id AND k.source = ?
    WHERE u.dptv_login IS NOT NULL
  `).all(KEY_SOURCE);
  let withdrawn = 0;
  for (const row of rows) {
    if (normalizeUrl(getSetting(row.id, 'xc_host', '')) !== base) continue;
    if (getSetting(row.id, 'xc_username', '') !== row.dptv_login) continue;
    const password = getSetting(row.id, 'xc_password', '');
    if (!password) continue;
    try {
      if (await checkLogin(base, row.dptv_login, password) === 'refused') {
        withdrawn += revokeIssuedKeys(row.id);
        console.log(`[dptv] DPTV-Server no longer accepts the login for user ${row.id}: its device keys were withdrawn`);
      }
    } catch { /* DPTV-Server unreachable: try again next time */ }
  }
  return withdrawn;
}

function startRecheck(intervalMs = 6 * 60 * 60 * 1000) {
  setInterval(() => { recheckIssuedKeys().catch(() => undefined); }, intervalMs).unref();
}

module.exports = {
  serverUrl,
  serverUrlFromEnv,
  setServerUrl,
  normalizeUrl,
  checkLogin,
  signIn,
  SignInError,
  linkAccount,
  revokeIssuedKeys,
  recheckIssuedKeys,
  startRecheck,
  resetLimits,
  MAX_FAILS_PER_LOGIN,
};
