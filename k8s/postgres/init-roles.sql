-- Runs ONCE, when the Postgres data volume is first initialised (docker-entrypoint-initdb.d, via
-- 10-gametorrent-roles.sh), as the superuser. Creates the two roles the app uses and the database.
-- Passwords come in as psql variables from the postgres-credentials Secret, never from this file.
--
--   gt_owner  owns the schema; only db/migrate.js (the webui pod's initContainer) uses it.
--   gt_app    what the running app connects as: read/write data, no schema changes, and
--             INSERT/SELECT-only on audit_log (revoked in webui/db/migrations/001_init.sql).
--   postgres  superuser; nobody uses it day to day.
--
-- cicd/tests/api-selftest.js runs this same file against the CI Postgres, so the test database
-- has exactly the production permission model.

create role gt_owner login password :'owner_pw';
create role gt_app login password :'app_pw';
create database gametorrent owner gt_owner;

-- Nobody but the superuser connects to the maintenance database.
revoke connect on database postgres from public;

\connect gametorrent

revoke all on database gametorrent from public;
grant connect on database gametorrent to gt_app;

-- Only gt_owner may create objects; gt_app may only use them.
revoke all on schema public from public;
alter schema public owner to gt_owner;
grant usage on schema public to gt_app;

-- Whatever gt_owner creates later (every migration) is automatically usable by gt_app.
alter default privileges for role gt_owner in schema public grant select, insert, update, delete on tables to gt_app;
alter default privileges for role gt_owner in schema public grant usage, select on sequences to gt_app;
