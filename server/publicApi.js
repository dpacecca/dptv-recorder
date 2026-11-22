// (2.10.6) API_PORT: a second port that serves only what DPTV-Player and DPTV Web need, for publishing
// through a Cloudflare Tunnel (or any reverse proxy) without the web UI, the password login or the
// admin API - the way DPTV-Server publishes its backend port and keeps its admin UI on the LAN.
// Everything else answers 404 there; the normal PORT keeps serving the whole app at home.

// Paths the players use. Each needs the device's API key, except recording-file/ (its short-lived
// token is the permission) and auth/dptv (a DPTV-Server login, rate-limited). version answers which
// release this is and is what DPTV-Player asks to tell whether the home address is reachable.
const PUBLIC_API = /^\/api\/(auth\/dptv|recordings(\/.*)?|recording-file\/[^/]+|timeshift(\/.*)?|sync\/status|version)$/;

function isPublicApiPath(path) {
  return PUBLIC_API.test(path || '');
}

/** The request handler for API_PORT: [app] for the paths above, a bare 404 for anything else. */
function publicApiHandler(app) {
  return (req, res) => {
    const path = (req.url || '').split('?')[0];
    if (isPublicApiPath(path)) return app(req, res);
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  };
}

module.exports = { isPublicApiPath, publicApiHandler };
