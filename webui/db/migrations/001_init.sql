-- 001: initial schema. Runs as gt_owner (see db/migrate.js); the app connects as gt_app, which
-- gets SELECT/INSERT/UPDATE/DELETE through the default privileges set up by
-- k8s/postgres/init-roles.sql — except on audit_log, see the bottom of this file.

-- People ---------------------------------------------------------------------------------------
create table users (
  id                   bigint generated always as identity primary key,
  username             text not null check (username ~ '^[A-Za-z0-9_.-]{3,32}$'),
  -- 'scrypt$N$r$p$salt$hash' (params stored so they can be raised later). Legacy 'salt:hash'
  -- from users.json is still accepted at login and rewritten in the new format on success.
  password_hash        text not null,
  role                 text not null default 'user' check (role in ('admin', 'user')),
  -- pending: signed up, waiting for an admin; disabled: can't log in, sessions deleted.
  status               text not null default 'active' check (status in ('pending', 'active', 'disabled')),
  must_change_password boolean not null default false,
  created_at           timestamptz not null default now(),
  created_by           bigint references users(id) on delete set null,
  approved_by          bigint references users(id) on delete set null,
  last_login_at        timestamptz,
  password_changed_at  timestamptz not null default now()
);
-- Case-insensitive uniqueness: "Admin" and "admin" can't both exist.
create unique index users_username_lower on users (lower(username));

-- Login sessions (express-session store, see lib/sessionStore.js). Deleting a user deletes
-- their sessions with them.
create table sessions (
  sid        text primary key,
  user_id    bigint references users(id) on delete cascade,
  sess       jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_expires_at on sessions (expires_at);
create index sessions_user_id on sessions (user_id);

-- Request -> download flow -----------------------------------------------------------------------
create table game_requests (
  id                uuid primary key,
  user_id           bigint references users(id) on delete set null,
  requested_by_name text not null,          -- snapshot; survives the user being deleted
  title             text not null,
  platform          text,
  input             jsonb not null,         -- validated download fields only; never scan options
  dedupe_key        text not null,
  status            text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at      timestamptz not null default now(),
  decided_at        timestamptz,
  decided_by_name   text,
  reason            text,
  job_id            uuid
);
create index game_requests_status_key on game_requests (status, dedupe_key);
create index game_requests_user on game_requests (user_id);

-- Finished download jobs (running ones live in memory; see lib/downloadManager.js).
create table download_jobs (
  id           uuid primary key,
  status       text not null,
  record       jsonb not null,             -- the job as the app tracks it
  scan_skipped boolean not null default false,
  started_at   timestamptz,
  finished_at  timestamptz
);

-- How often each installed game was downloaded (was data/stats.json).
create table game_stats (
  platform       text not null,
  folder         text not null,
  download_count integer not null default 0,
  primary key (platform, folder)
);

-- Admin configuration ----------------------------------------------------------------------------
create table feeds (
  id       uuid primary key,
  url      text not null unique,
  name     text,
  added_at timestamptz not null default now(),
  added_by text
);

create table providers (
  id          uuid primary key,
  name        text not null,
  base_url    text not null,
  api_key_enc text not null,               -- AES-256-GCM, see lib/secretBox.js
  added_at    timestamptz not null default now(),
  added_by    text
);

-- Audit trail ------------------------------------------------------------------------------------
create table audit_log (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  actor   text,
  ip      text,
  action  text not null,
  details jsonb not null default '{}'::jsonb
);
create index audit_log_at on audit_log (at);
create index audit_log_action on audit_log (action);

-- Append-only for the app: it can write and read entries, never change or remove them. Even a
-- fully compromised webui can't erase its tracks here. Pruning old entries is done as gt_owner.
revoke update, delete, truncate on audit_log from gt_app;
