#!/bin/sh
# Called by the postgres image's entrypoint on first initialisation only (empty data volume).
# Hands the role passwords to psql as variables, so they never appear in a file or in `ps`.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$GT_OWNER_PASSWORD" -v app_pw="$GT_APP_PASSWORD" \
  -f /etc/gametorrent/init-roles.sql
