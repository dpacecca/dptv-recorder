// Copies hls.js's prebuilt browser bundle into public/vendor at install time,
// so the frontend never depends on a CDN at runtime.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js');
const destDir = path.join(__dirname, '..', 'public', 'vendor');
const dest = path.join(destDir, 'hls.min.js');

try {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('[vendor-hls] copied hls.min.js -> public/vendor/');
} catch (err) {
  console.warn('[vendor-hls] could not vendor hls.js (will fall back if present already):', err.message);
}
