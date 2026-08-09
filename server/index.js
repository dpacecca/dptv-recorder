const path = require('path');
const express = require('express');
require('./db'); // ensures schema exists
const routes = require('./routes');
const { initScheduler } = require('./sync');
const recorder = require('./recorder');
const pkg = require('../package.json');

const app = express();
const PORT = process.env.PORT || 3000;
const BUILD_TIME = new Date().toISOString(); // stamped fresh every container start

app.use(express.json());
app.use('/api', routes);
app.get('/api/version', (req, res) => {
  res.json({ version: pkg.version, buildTime: BUILD_TIME, node: process.version });
});
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

app.listen(PORT, () => {
  console.log(`DPTV Recorder v${pkg.version} listening on port ${PORT} (build ${BUILD_TIME})`);
  initScheduler();
  recorder.init();
});
