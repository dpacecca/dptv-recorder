# Publishing DPTV Recorder to Docker Hub

Two ways to do this. **Option A** is "push code, everything else happens
automatically" - best if you're using GitHub Desktop and don't want to touch
a terminal for builds. **Option B** is a one-off manual build from your own
machine.

## Option A: GitHub Actions (automatic, recommended)

Every time you push to `main`, GitHub builds the image (for both `amd64` and
`arm64`) and pushes it to Docker Hub for you. The workflow file is already
included at `.github/workflows/docker-publish.yml` - you just need to give
it credentials.

### 1. Create a Docker Hub access token

1. Sign in at [hub.docker.com](https://hub.docker.com) (create an account if
   you don't have one - it's free).
2. **Account Settings → Security → New Access Token**.
3. Name it something like `github-actions`, give it **Read & Write** scope,
   and copy the token - you won't be able to see it again.

You don't need to manually create the repository on Docker Hub first - it'll
be created automatically the first time the workflow pushes to it.

### 2. Add the token to your GitHub repo as a secret

In your GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**. Add two secrets:

| Name                  | Value                                  |
|------------------------|-----------------------------------------|
| `DOCKERHUB_USERNAME`   | your Docker Hub username                |
| `DOCKERHUB_TOKEN`      | the access token you just created       |

### 3. Push

From GitHub Desktop: commit and push to `main` as usual. That's it - go to
your repo's **Actions** tab and you'll see "Build and publish to Docker Hub"
running. It typically takes a few minutes (longer the first time, since it's
building for two CPU architectures).

Once it finishes, your image is live at:
```
docker.io/YOUR_DOCKERHUB_USERNAME/dptv-recorder:latest
```

Every push to `main` after that re-publishes `latest` automatically. If you
want versioned releases too, push a git tag like `v1.0.0` and the workflow
will also publish `YOUR_USERNAME/dptv-recorder:1.0.0`.

### 4. Run it on Unraid straight from Docker Hub

No need to `git clone` the source anymore - just grab
`docker-compose.hub.yml` from the repo (or copy the snippet below) onto
Unraid:

```bash
mkdir -p /mnt/user/appdata/dptv-recorder
cd /mnt/user/appdata/dptv-recorder
# grab just the hub compose file - via git, or curl, or copy/paste it manually
curl -O https://raw.githubusercontent.com/YOUR_USERNAME/dptv-recorder/main/docker-compose.hub.yml

cat > .env << 'EOF'
DOCKERHUB_IMAGE=YOUR_DOCKERHUB_USERNAME/dptv-recorder:latest
HOST_PORT=3000
DATA_DIR=/mnt/user/appdata/dptv-recorder/data
RECORDINGS_DIR=/mnt/user/data/media/recording
PUID=99
PGID=100
TZ=Australia/Perth
EOF

docker compose -f docker-compose.hub.yml up -d
```

(If your repo is private, `curl` won't work without auth - just copy the
contents of `docker-compose.hub.yml` into a file on Unraid by hand instead.)

**To update:** `docker compose -f docker-compose.hub.yml pull && docker compose -f docker-compose.hub.yml up -d`

## Option B: Manual build and push (no GitHub Actions)

From your own machine, with the repo checked out and Docker installed:

```bash
docker login   # enter your Docker Hub username + password/token

docker build -t YOUR_DOCKERHUB_USERNAME/dptv-recorder:latest .
docker push YOUR_DOCKERHUB_USERNAME/dptv-recorder:latest
```

For a multi-arch build (so it also works on arm64 hosts like a Raspberry
Pi), use buildx instead:

```bash
docker buildx create --use   # one-time setup
docker buildx build --platform linux/amd64,linux/arm64 \
  -t YOUR_DOCKERHUB_USERNAME/dptv-recorder:latest \
  --push .
```

Then on Unraid, same as above: use `docker-compose.hub.yml` pointing at
`YOUR_DOCKERHUB_USERNAME/dptv-recorder:latest`.

## Making the repo public vs. keeping it private

Docker Hub images and their GitHub source are independent - your GitHub repo
can stay private while the Docker Hub image is public (or also private, if
you set the Docker Hub repo visibility to private, which then requires
`docker login` on the Unraid box too). Most people publish the image
publicly even when the source stays private, since the image itself doesn't
contain your XC credentials (those live in the SQLite DB on your `/data`
volume, created at runtime, never baked into the image).
