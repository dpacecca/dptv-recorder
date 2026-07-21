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

Recordings are captured with `ffmpeg -c copy` (stream copy, no re-encoding)
straight to **raw MPEG-TS (`.ts`)** files, using the same internal HLS proxy
the preview player uses — so nothing needs your XC credentials except the
backend itself.

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
  full `xmltv.php` EPG from your XC server into SQLite (`server/db.js`),
  doing a full replace each run. Programs outside a ~9-day window are
  dropped to keep the DB small.
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
