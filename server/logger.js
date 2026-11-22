const fs = require('fs');
const path = require('path');
const util = require('util');
const { DB_PATH } = require('./db');

// Lives alongside the sqlite DB, so it's already covered by whatever volume
// the DB is on (DATA_DIR) - no extra mount needed for logs to survive a
// container restart.
const LOG_PATH = process.env.LOG_PATH || path.join(path.dirname(DB_PATH), 'app.log');
const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate (keep the tail half) once exceeded

fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
let stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

function rotateIfNeeded() {
  let size;
  try {
    size = fs.statSync(LOG_PATH).size;
  } catch {
    return;
  }
  if (size <= MAX_LOG_BYTES) return;
  try {
    const buf = fs.readFileSync(LOG_PATH);
    const tail = buf.subarray(buf.length - MAX_LOG_BYTES / 2);
    const firstNewline = tail.indexOf(10); // '\n' - avoid keeping a half-written line
    const trimmed = firstNewline === -1 ? tail : tail.subarray(firstNewline + 1);
    stream.end();
    fs.writeFileSync(LOG_PATH, trimmed);
    stream = fs.createWriteStream(LOG_PATH, { flags: 'a' });
  } catch (err) {
    // rotation failing is not worth crashing over - just keep appending
  }
}

// Mirrors every console.log/info/warn/error call into LOG_PATH as well as
// stdout, so `docker logs` keeps working exactly as before while the app
// also has a plain-text file it can tail for the in-app log viewer. Install
// this before requiring anything else that logs at module-load time.
function install() {
  ['log', 'info', 'warn', 'error'].forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      try {
        rotateIfNeeded();
        stream.write(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${util.format(...args)}\n`);
      } catch {
        // never let file logging take the app down
      }
    };
  });
}

// The log file is capped at MAX_LOG_BYTES, so reading it whole is cheap -
// no need for a streaming tail implementation.
function readLastLines(maxLines) {
  let content;
  try {
    content = fs.readFileSync(LOG_PATH, 'utf8');
  } catch {
    return [];
  }
  const lines = content.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-maxLines);
}

module.exports = { install, readLastLines, LOG_PATH };
