const { getSetting } = require('./db');

// Sends a message via Gotify (https://gotify.net). Fails soft everywhere -
// notifications are a nice-to-have, never worth breaking a recording over.
async function sendGotify(title, message, priority = 5) {
  const url = getSetting('gotify_url', '');
  const token = getSetting('gotify_token', '');
  if (!url || !token) {
    return { ok: false, error: 'Gotify is not configured (missing server URL or app token).' };
  }

  const base = url.trim().replace(/\/+$/, '');
  const endpoint = `${base}/message?token=${encodeURIComponent(token)}`;

  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, message, priority }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gotify responded ${res.status}${body ? ': ' + body.slice(0, 200) : ''}`);
    }
    return { ok: true };
  } catch (err) {
    console.error('[notifier] failed to send Gotify notification:', err.message);
    return { ok: false, error: err.message };
  }
}

function eventEnabled(event) {
  // defaults to enabled for all three event types until the user changes it
  return getSetting(`notify_${event}`, '1') === '1';
}

function notifyRecordingStarted(programTitle) {
  if (!eventEnabled('started')) return;
  sendGotify('Recording started', `Scheduled recording of "${programTitle}" has started.`, 3);
}

function notifyRecordingCompleted(programTitle) {
  if (!eventEnabled('completed')) return;
  sendGotify('Recording completed', `Scheduled recording of "${programTitle}" has completed.`, 3);
}

function notifyRecordingFailed(programTitle, errorDetail) {
  if (!eventEnabled('failed')) return;
  const detail = errorDetail ? ` ${String(errorDetail).slice(0, 300)}` : '';
  sendGotify('Recording failed', `Scheduled recording of "${programTitle}" has failed.${detail}`, 8);
}

module.exports = {
  sendGotify,
  notifyRecordingStarted,
  notifyRecordingCompleted,
  notifyRecordingFailed,
};
