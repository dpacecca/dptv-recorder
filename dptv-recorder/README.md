# DPTV Recorder

A self-hosted channel guide + recorder for Xtream Codes (XC) IPTV servers:
categories on the left, a 7-day scrollable EPG timeline on the right, program
synopsis + click-to-play preview above it, a **Record** button to capture any
program straight to disk, and a manual or scheduled sync against your XC
server.

## Quick start

```bash
cp .env.example .env      # adjust HOST_PORT / DATA_DIR / RECORDINGS_DIR if you want
docker compose up -d --build
```

Then open **http://localhost:3000**. On first run it'll prompt you for your
XC server settings (server address, username, password). Saving triggers a
first sync automatically. Use **Sync now** any time, or set an auto-sync
interval in the header (off, 1/2/4/6/12/24 hours) — stored in the DB, so it
survives restarts.

Your XC credentials are stored only in the local SQLite database on the
`/data` volume — never sent to the browser. Live video (preview and
recording) is proxied through the backend with opaque, time-limited tokens,
so credentials never appear in browser devtools either.

## Recording

Select any program in the EPG (past-live, currently airing, or upcoming) and
the synopsis panel above the guide shows a **Record** button:

- **Record** → schedules it. If the program is already airing, recording
  starts immediately.
- **Scheduled** (amber) → click to cancel before it starts.
- **Recording** (red, pulsing) → click to stop early.
- **Recorded** (teal) → click to delete the file.
- **Failed** (red) → shows a short error, click to retry.

The little "⏺" button in the header opens the full recordings list (all
scheduled/active/completed/failed recordings, with cancel/delete), and shows
a badge with the number of active/scheduled recordings.

**Settings → Recording tab** lets you set:
- Minutes to start early (padding before the scheduled start)
- Minutes to keep recording after the scheduled end (padding after)
- Output format: raw `.ts`, or remux to `.mkv` (recommended - same
  `ffmpeg -c copy` stream copy either way, zero re-encoding/quality loss;
  `.mkv` just repackages the same audio/video into a container that plays
  back and seeks more reliably in Plex than raw broadcast `.ts`)

Recordings are captured with `ffmpeg -c copy` (stream copy, no re-encoding)
using the same internal HLS proxy the preview player uses — so nothing needs
your XC credentials except the backend itself. Filenames are based on the
program title alone (not the channel name too), since some providers embed
the event name directly in the channel name for PPV/event channels, which
made the old channel+title filename redundant.

### Where recordings are stored

Recordings are written inside the container at `/recordings`. In
`docker-compose.yml` that's mapped to the `RECORDINGS_DIR` folder on your
host (default `./recordings`, override via `.env`):

```yaml
volumes:
  - ${RECORDINGS_DIR:-./recordings}:/recordings
```

Point `RECORDINGS_DIR` at wherever you actually want the files — a big local
disk, a bind-mounted NAS folder, whatever you've already got mounted on the
host. Raw `.ts` isn't small, so make sure there's room.

## How it works

- **Sync** (`server/sync.js`) pulls live categories, live streams, and the
  full `xmltv.php` EPG from your XC server into SQLite (`server/db.js`).
  Categories/channels are fully replaced each run (cheap, and a channel
  lineup doesn't usually need history). Programs are upserted instead -
  matched by (channel, start, stop), only inserted if new or updated if
  something actually changed - rather than wiped and reinserted wholesale,
  so the guide doesn't flicker and unrelated data isn't touched on every
  sync. Programs outside a ~9-day window are pruned to keep the DB small.
- **API** (`server/routes.js`) serves categories/channels/EPG/search/settings
  /recordings to the frontend, and exposes `/api/stream/:channelId`, which
  builds the real XC stream URL server-side and redirects into the HLS
  proxy.
- **HLS proxy** (`server/hlsProxy.js`) fetches the `.m3u8` from XC, rewrites
  every referenced URL (variant playlists and segments) into opaque
  `/api/hls?u=<token>` links, and proxies the media bytes through. This is
  what keeps XC credentials out of the browser.
- **Recorder** (`server/recorder.js`) schedules and runs `ffmpeg` against
  that same internal `/api/stream/:channelId` endpoint, writing straight to
  `/recordings`. A lightweight ticker (every 15s) starts due recordings and
  catches anything that overruns its window. Recordings interrupted by a
  server restart are marked failed on the next boot (ffmpeg processes don't
  survive a restart).
- **Frontend** (`public/`) is plain HTML/CSS/JS — no build step — using
  `hls.js` (vendored locally at install time) for playback.

## Layout

- Left third: categories, filterable.
- Right two-thirds, top third: synopsis + Record button (50% width) and
  video preview (50% width, click to start/stop — never autoplays).
- Right two-thirds, bottom two-thirds: EPG timeline — channel logo + name on
  the left, a continuous horizontally-scrollable 7-day grid, a red "now"
  line, day-jump chips, and search (dims non-matches in the visible grid and
  shows a cross-category dropdown).

## Known limitations / things to revisit

- Assumes your XC server serves live channels as HLS (`.m3u8`). Providers
  that only offer raw MPEG-TS for live channels will need a small change to
  point `ffmpeg`/the proxy straight at the `.ts` endpoint — let me know if
  that's your situation.
- `xmltv.php` responses vary a lot between providers in how many days of EPG
  they actually include.
- Program-to-EPG matching relies on `epg_channel_id` from `get_live_streams`
  matching a `channel id` in `xmltv.php`.
- Single XC account/profile only, no multi-user accounts yet.
- No disk-space checks before starting a recording — keep an eye on the
  `RECORDINGS_DIR` volume.

## Local development (without Docker)

```bash
npm install
npm start
```

ffmpeg must be installed on your machine for recording to work locally. The
dev DB lands in `data/guide.db` and recordings in `/recordings` by default —
override with `DB_PATH` / `RECORDINGS_PATH`.

## Publishing to Docker Hub

See `DOCKERHUB_SETUP.md` for how to auto-publish this image to Docker Hub
via GitHub Actions on every push (so Unraid/other hosts can just `docker
pull` instead of building from source), or how to build/push it manually.

## Installing on Unraid

See `UNRAID_SETUP.md` — it includes a ready-to-use Community Applications
template (`unraid-template.xml`) and covers a known gotcha with Unraid's
auto-conversion of the image into a template (it can misconfigure
`DB_PATH`/`RECORDINGS_PATH` as host paths, which crashes the app on boot).

## Notifications

Settings → Notifications lets you wire up [Gotify](https://gotify.net) push
notifications for the recording lifecycle: started, completed, and failed
(each toggleable independently). Messages look like:

> Scheduled recording of "Program Name" has started/completed/failed.

You'll need a Gotify server URL and an application token (create one under
**Apps** in your Gotify instance). Use **Send test notification** to confirm
it's wired up correctly before relying on it. Notification failures never
block or fail a recording - they're logged and otherwise ignored.

## Watching a recording while it's still in progress

Whether a still-recording file is watchable in Plex depends entirely on the
output format:

- **Raw `.ts`**: works. MPEG-TS doesn't need a finalized "trailer" to be
  structurally valid, so a still-growing `.ts` file is playable.
- **Live `.mkv`**: generally does NOT work reliably. Matroska needs a proper
  trailer (duration + seek index) written at the very end to be well-formed -
  while still recording, the file is technically incomplete, and most
  players (Plex included) will show a wrong/missing duration or refuse it
  outright until the recording finishes.
- **`.ts` then remux to `.mkv`** (the recommended option): records as `.ts`
  throughout, so it's watchable while still recording exactly like the raw
  `.ts` option - then automatically remuxes to a properly finished `.mkv`
  once the recording completes, deleting the source `.ts`. Best of both.

Independent of all this: nothing stops you from just opening DPTV Recorder
itself and hitting play on the same channel that's currently recording -
that's true simultaneous live viewing, decoupled entirely from the file on
disk.

Remuxing (`-c copy`, whichever format) never re-encodes anything - it's pure
container repackaging, so it's fast and needs no GPU. The optional
`/dev/dri` passthrough in `docker-compose.yml` exists for possible future
hardware-accelerated transcoding, not anything the app does today.

## Multi-user accounts & authentication

**⚠️ Breaking change**: this version adds full multi-user support. Every
user gets their own XC server connection, channel lineup, EPG, recordings,
and settings - nothing is shared between accounts. Upgrading from an older
version automatically detects the old single-tenant database and resets
`settings`/`categories`/`channels`/`programs`/`recordings`/`epg_sources` to
the new per-user schema (there's no sane way to guess which user "owns" old
global data). Recording files already on disk aren't deleted, but their
database records are, so old recordings won't show up in the list anymore -
grab them directly from the `RECORDINGS_DIR` volume if you need them.

### First login

On first-ever startup with no users in the database, a default account is
created: **username `admin`, password `password`**. You'll be forced to set
a new password and confirm your first/last name and email before you can
use the app - the email in particular needs to match what Authentik (or
whatever IdP) sends if you plan to use SSO, since that's how accounts get
linked.

### Adding more users

Sign in as an admin → **Settings → Admin → Users** to add accounts (each
gets a temporary password and is forced to change it and confirm their
profile on first login, same as the default admin).

### OIDC / Authentik single sign-on

Settings → Admin (admin accounts only):
1. In Authentik, create an OAuth2/OIDC application + provider for DPTV
   Recorder. Note the issuer URL, client ID, and client secret.
2. Set the redirect URI in Authentik's provider config to exactly
   `https://your-dptv-host/api/auth/oidc/callback` (or `http://` if you're
   not running behind TLS) - it must match byte-for-byte what you enter in
   DPTV Recorder's OIDC settings.
3. Enter the issuer URL, client ID, client secret, and that same redirect
   URI in Settings → Admin, and save.
4. The login screen will now show a "Sign in with Authentik" button.

Account matching/creation on OIDC sign-in works like this: if the `sub`
claim already matches a linked account, you're in. Otherwise, if the `email`
claim matches an existing local account's email, that account gets linked
to your Authentik identity automatically. Otherwise, a brand new account is
created from the `given_name`/`family_name`/`email`/`preferred_username`
claims Authentik sends. Requested scopes: `openid profile email`.

### Sessions

Cookie-based, 30-day expiry, `HttpOnly`. If you're terminating TLS in front
of this app (recommended for anything beyond local/LAN use, especially once
you're sending real passwords over the network for local login), consider
setting the `secure` flag on the session cookie in `server/auth.js` - it's
left `false` by default so plain-HTTP LAN setups keep working out of the box.

## Exposing this externally (HTTPS)

See `CLOUDFLARE_TUNNEL.md` for the recommended setup (Cloudflare Tunnel with
proxied DNS - Cloudflare terminates HTTPS at their edge, so the app itself
doesn't need to natively serve TLS). Short version: set `COOKIE_SECURE=true`
in `.env` once you're consistently accessed over HTTPS.

If you're fronting the app with your own certificates instead of a
tunnel/reverse proxy, native HTTPS is also supported directly: set
`TLS_CERT_PATH` and `TLS_KEY_PATH` (both required together) to the
in-container paths of your certificate and key files.

## Channel/category sync behavior

Like programs, categories and channels are upserted rather than wiped and
reinserted every sync: new ones are added, changed ones (renamed channel,
recategorized, updated logo, etc.) are updated in place, and ones genuinely
missing from the provider's response are removed - all logged with explicit
+added/~updated/-removed counts (`docker logs`). If a sync ever gets back an
empty categories or channels list (a transient glitch, not an actual empty
lineup), existing data is left alone rather than being wiped - a real
provider outage shouldn't delete your whole channel list.

## Cloudflare Access (SSO passthrough, skip the login page entirely)

If Cloudflare Access already gates requests before they reach this app
(e.g. using Authentik as the Access identity provider), configure this
under Settings → Admin → Cloudflare Access:

- **Team domain** - e.g. `yourteam.cloudflareaccess.com`
- **Application AUD tag** - found on the Access application's Overview page
  in the Cloudflare dashboard

Once configured, any request that already carries a valid
`Cf-Access-Jwt-Assertion` header is verified against Cloudflare's public
keys and silently signed in - matched to an existing account by email, or a
new one created automatically from the identity Cloudflare provides. The
login screen is never shown at all in this case. This fails open on any
missing config or invalid token (falls through to the normal login flow),
so it can never accidentally lock anyone out.

## Disabling password login (SSO-only)

Once OIDC is configured (Settings → Admin), you can check "Hide
username/password login" to show only the SSO button on the login screen.
This only actually takes effect while OIDC is genuinely configured - if SSO
breaks or gets unconfigured later, the password fields automatically become
available again rather than locking everyone out. There's also always a
"Use username/password instead" link on the login screen as a manual
fallback, even while this is enabled.

## Mobile

The app is responsive down to phone-sized screens: the categories panel
becomes a full-screen overlay (auto-collapses after picking a category),
synopsis and video preview stack vertically instead of side-by-side, and
the header/controls reflow to fit. The video preview also has a full-screen
button (bottom right of the preview panel once playing) for proper live
viewing, including on mobile - audio is unmuted automatically once you
start playback, since that's always triggered by an explicit tap/click.
