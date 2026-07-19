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

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app /app

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/guide.db
ENV RECORDINGS_PATH=/recordings

EXPOSE 3000
VOLUME ["/data", "/recordings"]

CMD ["node", "server/index.js"]
