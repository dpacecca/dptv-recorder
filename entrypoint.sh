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

# Recursively fix /data - it's small (just the sqlite db + wal/shm files), so
# this is cheap, and it's what actually matters: an existing guide.db left
# over from a run under a different PUID/PGID (e.g. before this was added,
# or after changing PUID/PGID) would otherwise stay unwritable forever.
chown -R "$PUID":"$PGID" /data

# /recordings can get large, so a full recursive chown on every start could
# get slow with a big library. Newly-written recordings will always be owned
# correctly regardless (ownership comes from the process, not old files), so
# a non-recursive chown of the directory itself is enough for normal use.
# If you change PUID/PGID after already having recordings on disk, fix their
# ownership once with: chown -R <PUID>:<PGID> /path/to/recordings (on the host)
chown "$PUID":"$PGID" /recordings

echo "[entrypoint] running as ${USER_NAME}:${GROUP_NAME} (${PUID}:${PGID})"
exec gosu "$PUID":"$PGID" "$@"
