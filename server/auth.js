const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_COOKIE = 'dptv_session';

// ---------------- bootstrap ----------------
function bootstrapDefaultAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;

  const passwordHash = bcrypt.hashSync('password', 10);
  db.prepare(`
    INSERT INTO users (username, password_hash, first_name, last_name, email, must_change_password, is_admin, created_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?)
  `).run('admin', passwordHash, 'Admin', 'User', 'admin@localhost', Date.now());
  console.log('[auth] no users existed - created default account: username "admin", password "password" (must be changed at first login)');
}

// ---------------- user CRUD ----------------
function sanitizeUser(row) {
  if (!row) return null;
  const { password_hash, ...safe } = row;
  return safe;
}

function findUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}
function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
}
function findUserByOidcSubject(sub) {
  return db.prepare('SELECT * FROM users WHERE oidc_subject = ?').get(sub);
}
function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at ASC').all().map(sanitizeUser);
}

function createUser({ username, password, firstName, lastName, email, isAdmin = false, mustChangePassword = false, oidcSubject = null }) {
  const passwordHash = password ? bcrypt.hashSync(password, 10) : null;
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, first_name, last_name, email, must_change_password, oidc_subject, is_admin, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(username, passwordHash, firstName, lastName, String(email).toLowerCase(), mustChangePassword ? 1 : 0, oidcSubject, isAdmin ? 1 : 0, Date.now());
  return findUserById(info.lastInsertRowid);
}

function verifyPassword(user, password) {
  if (!user || !user.password_hash) return false;
  return bcrypt.compareSync(password, user.password_hash);
}

function setPassword(userId, newPassword) {
  const hash = bcrypt.hashSync(newPassword, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(hash, userId);
}

function updateProfile(userId, { firstName, lastName, email, username }) {
  const user = findUserById(userId);
  if (!user) throw new Error('User not found');

  if (username && username !== user.username) {
    const existing = findUserByUsername(username);
    if (existing && existing.id !== userId) throw new Error('That username is already taken.');
  }
  if (email && email.toLowerCase() !== user.email) {
    const existing = findUserByEmail(email);
    if (existing && existing.id !== userId) throw new Error('That email is already in use.');
  }

  db.prepare(`
    UPDATE users SET
      first_name = ?, last_name = ?, email = ?, username = ?
    WHERE id = ?
  `).run(
    firstName ?? user.first_name,
    lastName ?? user.last_name,
    (email ?? user.email).toLowerCase(),
    username ?? user.username,
    userId
  );
  return findUserById(userId);
}

function linkOidcSubject(userId, sub) {
  db.prepare('UPDATE users SET oidc_subject = ? WHERE id = ?').run(sub, userId);
}

// ---------------- sessions ----------------
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now + SESSION_TTL_MS, now);
  return token;
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function destroyAllSessionsForUser(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function resolveSession(token) {
  if (!token) return null;
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return findUserById(row.user_id);
}

setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}, 60 * 60 * 1000).unref();

// ---------------- middleware ----------------
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[SESSION_COOKIE];
  const user = resolveSession(token);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  if (user.must_change_password) {
    return res.status(403).json({ error: 'Password change required.', mustChangePassword: true });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

// Defaults to false so plain-HTTP LAN access keeps working out of the box.
// Set COOKIE_SECURE=true once you're consistently accessed over HTTPS (e.g.
// exclusively through a Cloudflare Tunnel) - a "secure" cookie is enforced
// by the browser based on the scheme IT used (https://your-domain), not
// what protocol the tunnel/proxy uses to reach this container, so it's safe
// to enable even though the app itself only ever speaks plain HTTP here.
// Leave it off if you also access the app directly over LAN http://, since
// the browser won't send a secure cookie back over an insecure connection.
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    secure: COOKIE_SECURE,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE);
}

module.exports = {
  SESSION_COOKIE,
  bootstrapDefaultAdmin,
  sanitizeUser,
  findUserById,
  findUserByUsername,
  findUserByEmail,
  findUserByOidcSubject,
  listUsers,
  createUser,
  verifyPassword,
  setPassword,
  updateProfile,
  linkOidcSubject,
  createSession,
  destroySession,
  destroyAllSessionsForUser,
  resolveSession,
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
};
