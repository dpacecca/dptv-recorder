const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const { getSystemSetting } = require('./db');
const { findUserByEmail, findUserByUsername, createUser } = require('./auth');

let cachedClient = null;
let cachedTeamDomain = null;

function cfAccessConfigured() {
  return !!(getSystemSetting('cf_access_team_domain', '') && getSystemSetting('cf_access_aud', ''));
}

function getJwksClient(teamDomain) {
  if (cachedClient && cachedTeamDomain === teamDomain) return cachedClient;
  cachedClient = jwksClient({
    jwksUri: `https://${teamDomain}/cdn-cgi/access/certs`,
    cache: true,
    cacheMaxAge: 60 * 60 * 1000, // 1h
    rateLimit: true,
  });
  cachedTeamDomain = teamDomain;
  return cachedClient;
}

function resetCache() {
  cachedClient = null;
  cachedTeamDomain = null;
}

// Verifies a Cf-Access-Jwt-Assertion token against Cloudflare's public keys
// for the configured team, checking signature, audience (this specific
// Access application), and issuer. Resolves with the decoded claims
// (includes "email") on success, rejects otherwise.
function verifyToken(token) {
  return new Promise((resolve, reject) => {
    const teamDomain = getSystemSetting('cf_access_team_domain', '');
    const aud = getSystemSetting('cf_access_aud', '');
    if (!teamDomain || !aud) return reject(new Error('Cloudflare Access is not configured'));

    const client = getJwksClient(teamDomain);
    function getKey(header, callback) {
      client.getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
        callback(null, key.getPublicKey());
      });
    }

    jwt.verify(token, getKey, {
      audience: aud,
      issuer: `https://${teamDomain}`,
      algorithms: ['RS256'],
    }, (err, decoded) => {
      if (err) return reject(err);
      resolve(decoded);
    });
  });
}

function uniqueUsernameFrom(base) {
  let candidate = base.replace(/[^a-z0-9_.-]/gi, '').slice(0, 40) || 'user';
  let n = 0;
  while (findUserByUsername(candidate)) {
    n += 1;
    candidate = `${base}${n}`;
  }
  return candidate;
}

function findOrCreateUserFromCfAccessClaims(claims) {
  if (!claims.email) {
    throw new Error('Cloudflare Access did not provide an email claim.');
  }
  let user = findUserByEmail(claims.email);
  if (user) return user;

  const baseUsername = claims.email.split('@')[0];
  return createUser({
    username: uniqueUsernameFrom(baseUsername),
    password: null,
    firstName: claims.given_name || claims.email.split('@')[0],
    lastName: claims.family_name || '',
    email: claims.email,
    mustChangePassword: false,
  });
}

module.exports = {
  cfAccessConfigured,
  verifyToken,
  resetCache,
  findOrCreateUserFromCfAccessClaims,
};
