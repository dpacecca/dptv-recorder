# Getting this into your private GitHub repo

## 1. Create the repo

On GitHub: **New repository** → name it (e.g. `dptv-recorder`) → set
**Private** → do *not* initialize with a README/gitignore (this project
already has both) → **Create repository**.

## 2. Push this code to it

From inside the unzipped project folder on your own machine:

```bash
cd dptv-recorder
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin git@github.com:YOUR_USERNAME/dptv-recorder.git
git push -u origin main
```

(Use the HTTPS URL instead of the SSH one if that's what you've got set up:
`https://github.com/YOUR_USERNAME/dptv-recorder.git`.)

A few files are intentionally left out of git via `.gitignore` — your
`.env`, the SQLite database, recorded `.ts` files, `node_modules`, and the
vendored `hls.min.js` (all regenerated automatically on install/build).

## 3. Install on the machine that will actually run it

This can be the same machine or a different one (e.g. a home server/NAS) —
it just needs Docker, Docker Compose, and network access to your private
GitHub repo.

```bash
git clone https://github.com/YOUR_USERNAME/dptv-recorder.git
cd dptv-recorder
cp .env.example .env
# edit .env if you want a different port, or different host paths for the
# database / recordings

docker compose up -d --build
```

Since the repo is private, `git clone` will prompt for credentials. Easiest
options:
- **HTTPS + a Personal Access Token**: when prompted for a password, paste a
  GitHub PAT with `repo` scope instead of your account password.
- **SSH key**: add a deploy key or your own SSH public key to the repo's
  **Settings → Deploy keys**, then clone with the `git@github.com:...` URL.

## 4. Updating later

```bash
cd dptv-recorder
git pull
docker compose up -d --build
```

Your database and recordings live outside the git repo (in the `DATA_DIR`
and `RECORDINGS_DIR` folders from `.env`), so pulling updates and rebuilding
the image won't touch them.
