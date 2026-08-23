// Copies mpegts.js's prebuilt browser bundle into public/vendor at install
// time, so the frontend never depends on a CDN at runtime.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'mpegts.js', 'dist', 'mpegts.js');
const destDir = path.join(__dirname, '..', 'public', 'vendor');
const dest = path.join(destDir, 'mpegts.js');

try {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('[vendor-mpegts] copied mpegts.js -> public/vendor/');
} catch (err) {
  console.warn('[vendor-mpegts] could not vendor mpegts.js (will fall back if present already):', err.message);
}
