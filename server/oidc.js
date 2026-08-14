const { Issuer, generators } = require('openid-client');
const { getSystemSetting } = require('./db');
const {
  findUserByOidcSubject, findUserByEmail, findUserByUsername,
  createUser, linkOidcSubject,
} = require('./auth');

let cachedClient = null;
let cachedIssuerUrl = null;

function oidcConfigured() {
  return !!(getSystemSetting('oidc_issuer') && getSystemSetting('oidc_client_id') && getSystemSetting('oidc_redirect_uri'));
}

async function getClient() {
  const issuerUrl = getSystemSetting('oidc_issuer');
  const clientId = getSystemSetting('oidc_client_id');
  const clientSecret = getSystemSetting('oidc_client_secret');
  const redirectUri = getSystemSetting('oidc_redirect_uri');

  if (!issuerUrl || !clientId || !redirectUri) {
    throw new Error('OIDC is not fully configured - set the issuer URL, client ID, and redirect URI in Settings.');
  }

  if (cachedClient && cachedIssuerUrl === issuerUrl) return cachedClient;

  const issuer = await Issuer.discover(issuerUrl);
  cachedClient = new issuer.Client({
    client_id: clientId,
    client_secret: clientSecret || undefined,
    redirect_uris: [redirectUri],
    response_types: ['code'],
    token_endpoint_auth_method: clientSecret ? 'client_secret_basic' : 'none',
  });
  cachedIssuerUrl = issuerUrl;
  return cachedClient;
}

function resetClientCache() {
  cachedClient = null;
  cachedIssuerUrl = null;
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

// Finds an existing local account linked to this OIDC subject, links one by
// matching email if a local account already exists with that address, or
// creates a brand new account from the claims Authentik sends back.
function findOrCreateUserFromClaims(claims) {
  let user = findUserByOidcSubject(claims.sub);
  if (user) return user;

  if (claims.email) {
    user = findUserByEmail(claims.email);
    if (user) {
      linkOidcSubject(user.id, claims.sub);
      return user;
    }
  }

  if (!claims.email) {
    throw new Error('Your identity provider did not send an email claim, which DPTV Recorder requires to create an account.');
  }

  const baseUsername = claims.preferred_username || claims.email.split('@')[0];
  return createUser({
    username: uniqueUsernameFrom(baseUsername),
    password: null,
    firstName: claims.given_name || 'First',
    lastName: claims.family_name || 'Last',
    email: claims.email,
    oidcSubject: claims.sub,
    mustChangePassword: false,
  });
}

module.exports = {
  oidcConfigured,
  getClient,
  resetClientCache,
  findOrCreateUserFromClaims,
  generators,
};
