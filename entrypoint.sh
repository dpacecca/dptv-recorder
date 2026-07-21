#!/bin/sh
set -e

PUID="${PUID:-99}"
PGID="${PGID:-100}"

if ! getent group "$PGID" >/dev/null 2>&1; then
  addgroup --gid "$PGID" appgroup
fi
GROUP_NAME=$(getent group "$PGID" | cut -d: -f1)

if ! getent passwd "$PUID" >/dev/null 2>&1; then
  adduser --uid "$PUID" --gid "$PGID" --disabled-password --gecos "" appuser >/dev/null
fi
USER_NAME=$(getent passwd "$PUID" | cut -d: -f1)

mkdir -p /data /recordings
chown "$PUID":"$PGID" /data /recordings

echo "[entrypoint] running as ${USER_NAME}:${GROUP_NAME} (${PUID}:${PGID})"
exec gosu "$PUID":"$PGID" "$@"
