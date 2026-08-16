const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const cookieParser = require('cookie-parser');
require('./db'); // ensures schema exists
const routes = require('./routes');
const authRoutes = require('./authRoutes');
const { hlsProxyHandler } = require('./hlsProxy');
const { initScheduler } = require('./sync');
const recorder = require('./recorder');
const { bootstrapDefaultAdmin } = require('./auth');
const pkg = require('../package.json');
const { cloudflareAccessMiddleware } = require('./cloudflareAccess');

const app = express();
const PORT = process.env.PORT || 3000;
const BUILD_TIME = new Date().toISOString(); // stamped fresh every container start

// Required when running behind any reverse proxy/tunnel (Cloudflare Tunnel,
// nginx, Traefik, etc). Without this, Express has no way to know the
// original request was HTTPS (it only ever sees a plain HTTP connection
// from the proxy/tunnel daemon), which matters for anything that checks
// req.secure or X-Forwarded-* headers. Harmless if you're not behind one.
app.set('trust proxy', 1);

app.use(express.json());
app.use(cookieParser());
app.use(cloudflareAccessMiddleware);

app.get('/api/version', (req, res) => {
  res.json({ version: pkg.version, buildTime: BUILD_TIME, node: process.version });
});

// Unauthenticated: ffmpeg and the browser both hit this directly with no
// session cookie. Its security model is the opaque, short-lived per-stream
// token in the URL itself, not a login session.
app.get('/api/hls/:tokenExt', hlsProxyHandler);

// Auth endpoints (login, OIDC, password change, admin user management) -
// intentionally NOT behind the main auth middleware, since /login and the
// OIDC flow are how you get a session in the first place.
app.use('/api/auth', authRoutes);

// Everything else under /api requires a signed-in session (enforced inside
// routes.js itself via router.use(auth.requireAuth)).
app.use('/api', routes);

app.use(express.static(path.join(__dirname, '..', 'public'), {
  // force revalidation on every load rather than trusting any intermediate
  // cache - important while actively iterating on fixes
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

function startServer() {
  bootstrapDefaultAdmin();
  initScheduler();
  recorder.init();
}

// Optional native HTTPS - NOT needed for a Cloudflare Tunnel setup (the
// tunnel already terminates public TLS at Cloudflare's edge and reaches
// this container over plain HTTP/its own encrypted tunnel protocol either
// way). This is here for anyone fronting the app with their own certs
// instead of a tunnel/reverse proxy. Set both TLS_CERT_PATH and
// TLS_KEY_PATH to enable it; otherwise the app just serves plain HTTP as
// always, which is the right choice behind Cloudflare Tunnel, nginx,
// Traefik, or any other TLS-terminating proxy.
const certPath = process.env.TLS_CERT_PATH;
const keyPath = process.env.TLS_KEY_PATH;

if (certPath && keyPath) {
  const options = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  https.createServer(options, app).listen(PORT, () => {
    console.log(`DPTV Recorder v${pkg.version} listening on port ${PORT} over HTTPS (build ${BUILD_TIME})`);
    startServer();
  });
} else {
  http.createServer(app).listen(PORT, () => {
    console.log(`DPTV Recorder v${pkg.version} listening on port ${PORT} (build ${BUILD_TIME})`);
    startServer();
  });
}
