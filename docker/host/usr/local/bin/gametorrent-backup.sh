#!/bin/sh
# Nightly backup of GameTorrent's live app state on k3s.
#
# What it backs up:
#   gametorrent.pgdump  the webui's PostgreSQL database (users, sessions, requests, job history,
#                       feeds, providers, stats, audit log): a consistent pg_dump, taken through
#                       `kubectl exec` (NetworkPolicy lets nothing else reach the database)
# and three small PVCs in the `gametorrent` namespace, read straight from k3s's local-path storage
# on this host (/var/lib/rancher/k3s/storage/):
#   webui-data       the old JSON files (pre-database, kept read-only as a rollback copy) + cover-art cache
#   jackett-config   Jackett's indexer setup + API key
#   uptime-kuma-data Uptime Kuma's monitors (SQLite)
# The postgres-data PVC itself is NOT copied as files: copying a running database's files gives
# a possibly inconsistent copy; pg_dump doesn't.
# NOT backed up on purpose: webui-roms / webui-downloads (large, re-downloadable),
# webui-clamav-db (re-fetched by freshclam), and the observability PVCs (logs/metrics are
# disposable history, not state).
#
# History: until 2026-11-04 this script tarred the Docker volume `gametorrent-webui-data`, which
# stopped being the live data at the k3s cutover on 2026-10-10 — every nightly archive after that
# was the same stale snapshot. See docs/DEBUG.md ("Backups") and docker/host/README.md.
#
# Consistency: each PVC is copied to a staging dir first (a sub-second window), then tarred.
# The JSON files are written whole by the app, so a copy is consistent. Uptime Kuma's SQLite DB
# is copied together with its -wal/-shm files while running: crash-consistent (SQLite replays the
# WAL on open), which is fine for monitor config but not a transactional snapshot.
#
# Keeps the newest 7 archives (live-pvc-*.tgz). Old Docker-era webui-data-*.tgz files are left
# alone — they are the only copy of the pre-cutover state.
set -eu
umask 077

DEST=/var/backups/gametorrent
STORAGE=/var/lib/rancher/k3s/storage
NS=gametorrent
PVCS="webui-data jackett-config uptime-kuma-data"
KUBECTL="k3s kubectl"

mkdir -p "$DEST"; chmod 700 "$DEST"
TS=$(date +%F-%H%M)
OUT="$DEST/live-pvc-$TS.tgz"
STAGE=$(mktemp -d "$DEST/.staging.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT

for pvc in $PVCS; do
  # local-path names each dir pvc-<uid>_<namespace>_<claim>; the uid changes if the PVC is
  # ever recreated, so match on namespace+claim and insist on exactly one hit.
  set -- "$STORAGE"/pvc-*_"${NS}"_"${pvc}"
  if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then
    logger -t gametorrent-backup "FAILED: expected exactly one dir for PVC $NS/$pvc, found: $*"
    echo "expected exactly one dir for PVC $NS/$pvc, found: $*" >&2
    exit 1
  fi
  # Stage under the claim name (stable across PVC recreation) rather than the uid'd dir name.
  cp -a "$1" "$STAGE/$pvc"
done

# Database dump. Required once Postgres exists (from the 2026-11 database cutover on); skipped,
# with a log line, only when the cluster positively says it doesn't exist (NotFound). Any other
# error (k3s down, API unreachable) fails the backup instead of quietly leaving the database out.
DUMP=""
if PG_CHECK=$($KUBECTL -n "$NS" get statefulset postgres -o name 2>&1); then
  PG_EXISTS=1
elif echo "$PG_CHECK" | grep -q NotFound; then
  PG_EXISTS=0
else
  logger -t gametorrent-backup "FAILED: can't ask the cluster whether postgres exists: $PG_CHECK"
  echo "kubectl failed: $PG_CHECK" >&2
  exit 1
fi
if [ "$PG_EXISTS" = 1 ]; then
  if ! $KUBECTL -n "$NS" exec postgres-0 -c postgres -- pg_dump -U postgres -Fc gametorrent > "$STAGE/gametorrent.pgdump"; then
    logger -t gametorrent-backup "FAILED: pg_dump of gametorrent failed"
    echo "pg_dump failed" >&2
    exit 1
  fi
  # Verify it's a readable archive with the tables in it, using the server's own pg_restore.
  if ! $KUBECTL -n "$NS" exec -i postgres-0 -c postgres -- pg_restore --list < "$STAGE/gametorrent.pgdump" | grep -q "TABLE public users"; then
    logger -t gametorrent-backup "FAILED: pg_dump output is not a readable archive with the users table"
    echo "pg_dump output unreadable" >&2
    exit 1
  fi
  DUMP=gametorrent.pgdump
else
  logger -t gametorrent-backup "note: no postgres statefulset yet, database dump skipped"
fi

tar czf "$OUT" --numeric-owner -C "$STAGE" $PVCS $DUMP

# Verify before trusting it: gzip intact, and the files that matter are actually inside.
gzip -t "$OUT"
LIST=$(tar tzf "$OUT")
for must in webui-data/users.json jackett-config/Jackett/ServerConfig.json uptime-kuma-data/kuma.db $DUMP; do
  echo "$LIST" | grep -qxF "$must" || {
    logger -t gametorrent-backup "FAILED: $OUT is missing $must"
    echo "$OUT is missing $must" >&2
    rm -f "$OUT"
    exit 1
  }
done

ls -1t "$DEST"/live-pvc-2*.tgz | tail -n +8 | xargs -r rm -f
logger -t gametorrent-backup "ok: $OUT ($(stat -c %s "$OUT") bytes)"
