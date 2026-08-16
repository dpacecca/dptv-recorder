const express = require('express');
const auth = require('./auth');
const oidc = require('./oidc');
const cfAccess = require('./cloudflareAccess');
const { getSystemSetting, setSystemSetting } = require('./db');

const router = express.Router();

// ---------------- local login ----------------
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });

  const user = auth.findUserByUsername(username);
  if (!user || !auth.verifyPassword(user, password)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  const token = auth.createSession(user.id);
  auth.setSessionCookie(res, token);
  res.json({ ok: true, user: auth.sanitizeUser(user) });
});

router.post('/logout', (req, res) => {
  const token = req.cookies && req.cookies[auth.SESSION_COOKIE];
  if (token) auth.destroySession(token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// current user - used by the frontend to decide whether to show the login
// screen, the forced password-change screen, or the main app
router.get('/me', (req, res) => {
  const token = req.cookies && req.cookies[auth.SESSION_COOKIE];
  const user = auth.resolveSession(token);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user: auth.sanitizeUser(user) });
});

// ---------------- forced/self-serve password change ----------------
router.post('/change-password', (req, res) => {
  const token = req.cookies && req.cookies[auth.SESSION_COOKIE];
  const user = auth.resolveSession(token);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  const { currentPassword, newPassword, firstName, lastName, email, username } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  // skip the current-password check only for the forced first-login flow -
  // otherwise require it, so a hijacked session can't silently lock out the
  // real owner by changing their password
  if (!user.must_change_password) {
    if (!currentPassword || !auth.verifyPassword(user, currentPassword)) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
  }

  try {
    if (user.must_change_password) {
      if (!firstName || !lastName || !email) {
        return res.status(400).json({ error: 'First name, last name, and email are required.' });
      }
      auth.updateProfile(user.id, { firstName, lastName, email, username });
    }
    auth.setPassword(user.id, newPassword);
    res.json({ ok: true, user: auth.sanitizeUser(auth.findUserById(user.id)) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- profile ----------------
router.put('/profile', (req, res) => {
  const token = req.cookies && req.cookies[auth.SESSION_COOKIE];
  const user = auth.resolveSession(token);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  try {
    const updated = auth.updateProfile(user.id, req.body || {});
    res.json({ ok: true, user: auth.sanitizeUser(updated) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------- OIDC (Authentik) ----------------
router.get('/oidc/status', (req, res) => {
  const configured = oidc.oidcConfigured();
  const disablePasswordLogin = getSystemSetting('disable_password_login', '0') === '1';
  res.json({
    configured,
    // only actually honor the "hide password login" preference if SSO is
    // genuinely configured - never let a stale setting lock everyone out
    passwordLoginDisabled: configured && disablePasswordLogin,
  });
});

router.get('/oidc/login', async (req, res) => {
  try {
    const client = await oidc.getClient();
    const codeVerifier = oidc.generators.codeVerifier();
    const codeChallenge = oidc.generators.codeChallenge(codeVerifier);
    const state = oidc.generators.state();

    const secure = process.env.COOKIE_SECURE === 'true';
    res.cookie('oidc_verifier', codeVerifier, { httpOnly: true, sameSite: 'lax', maxAge: 5 * 60 * 1000, secure });
    res.cookie('oidc_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 5 * 60 * 1000, secure });

    const url = client.authorizationUrl({
      scope: 'openid profile email',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
    });
    res.redirect(url);
  } catch (err) {
    res.status(400).send(`OIDC login could not start: ${err.message}`);
  }
});

router.get('/oidc/callback', async (req, res) => {
  try {
    const client = await oidc.getClient();
    const params = client.callbackParams(req);
    const codeVerifier = req.cookies && req.cookies.oidc_verifier;
    const state = req.cookies && req.cookies.oidc_state;
    res.clearCookie('oidc_verifier');
    res.clearCookie('oidc_state');

    const redirectUri = getSystemSetting('oidc_redirect_uri');
    const tokenSet = await client.callback(redirectUri, params, { code_verifier: codeVerifier, state });
    const claims = tokenSet.claims();

    const user = oidc.findOrCreateUserFromClaims(claims);
    const token = auth.createSession(user.id);
    auth.setSessionCookie(res, token);
    res.redirect('/');
  } catch (err) {
    console.error('[oidc] callback failed:', err.message);
    res.status(400).send(`Sign-in failed: ${err.message}`);
  }
});

// ---------------- admin: OIDC configuration ----------------
router.get('/admin/oidc-settings', auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({
    issuer: getSystemSetting('oidc_issuer', ''),
    clientId: getSystemSetting('oidc_client_id', ''),
    hasClientSecret: !!getSystemSetting('oidc_client_secret', ''),
    redirectUri: getSystemSetting('oidc_redirect_uri', ''),
    disablePasswordLogin: getSystemSetting('disable_password_login', '0') === '1',
  });
});

router.post('/admin/oidc-settings', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const { issuer, clientId, clientSecret, redirectUri, disablePasswordLogin } = req.body || {};
  if (issuer !== undefined) setSystemSetting('oidc_issuer', issuer);
  if (clientId !== undefined) setSystemSetting('oidc_client_id', clientId);
  if (clientSecret) setSystemSetting('oidc_client_secret', clientSecret); // blank = keep existing
  if (redirectUri !== undefined) setSystemSetting('oidc_redirect_uri', redirectUri);
  if (disablePasswordLogin !== undefined) setSystemSetting('disable_password_login', disablePasswordLogin ? '1' : '0');
  oidc.resetClientCache();
  res.json({ ok: true });
});

// ---------------- admin: Cloudflare Access ----------------
router.get('/admin/cloudflare-access-settings', auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json({
    teamDomain: getSystemSetting('cf_access_team_domain', ''),
    aud: getSystemSetting('cf_access_aud', ''),
    configured: cfAccess.cfAccessConfigured(),
  });
});

router.post('/admin/cloudflare-access-settings', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const { teamDomain, aud } = req.body || {};
  if (teamDomain !== undefined) setSystemSetting('cf_access_team_domain', teamDomain);
  if (aud !== undefined) setSystemSetting('cf_access_aud', aud);
  cfAccess.resetCache();
  res.json({ ok: true });
});

// ---------------- admin: user management ----------------
router.get('/admin/users', auth.requireAuth, auth.requireAdmin, (req, res) => {
  res.json(auth.listUsers());
});

router.post('/admin/users', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const { username, password, firstName, lastName, email, isAdmin } = req.body || {};
  if (!username || !password || !firstName || !lastName || !email) {
    return res.status(400).json({ error: 'Username, password, first name, last name, and email are all required.' });
  }
  if (auth.findUserByUsername(username)) return res.status(400).json({ error: 'That username is already taken.' });
  if (auth.findUserByEmail(email)) return res.status(400).json({ error: 'That email is already in use.' });
  try {
    const user = auth.createUser({
      username, password, firstName, lastName, email,
      isAdmin: !!isAdmin, mustChangePassword: true,
    });
    res.json(auth.sanitizeUser(user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/admin/users/:id', auth.requireAuth, auth.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't delete your own account while signed in as it." });
  auth.destroyAllSessionsForUser(id);
  require('./db').db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

module.exports = router;
