# ---- build stage ----
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# build tools for better-sqlite3 in case a prebuilt binary isn't available
# for the target platform (e.g. arm64 Raspberry Pi hosts)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY . .
RUN npm install --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg gosu tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/guide.db
ENV RECORDINGS_PATH=/recordings
ENV TZ=UTC
# Unraid's default "nobody:users" - override via docker-compose/.env to match your host
ENV PUID=99
ENV PGID=100

EXPOSE 3000
VOLUME ["/data", "/recordings"]

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "server/index.js"]
