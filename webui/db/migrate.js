#!/usr/bin/env node
/**
 * Applies database migrations, then (once) imports the old JSON files. Runs as gt_owner, the only
 * role allowed to change the schema, from DATABASE_OWNER_URL. In k8s this is the webui pod's
 * `db-migrate` initContainer: it finishes before the app starts, and the app container itself
 * never gets the owner credentials.
 *
 *   node db/migrate.js
 *
 * Migrations: every db/migrations/NNN_name.sql not yet in schema_migrations, in order, each in its
 * own transaction. A Postgres advisory lock stops two runs overlapping.
 *
 * Import (one-time, the move off JSON files): if the users table is empty and
 * <data dir>/users.json exists, everything in users.json, requests.json, downloads.json,
 * feeds.json, providers.json, stats.json and audit.log is copied in ONE transaction. Either it all
 * lands or nothing does. The JSON files are only read, never changed, so rolling back to the
 * previous image still finds them intact. Recorded as 'import:json-v1' in schema_migrations.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const passwords = require('../lib/passwords');
const secretBox = require('../lib/secretBox');
const { DATA_DIR } = require('../lib/paths');
const { dedupeKeyFor } = require('../lib/requests');

// Triaged false positive (semgrep node_sqli_injection, here and in applyMigrations): the SQL run
// below is the migration files shipped inside the image (db/migrations/*.sql), never anything from
// a request or a user. Every query that does take outside values uses $1 placeholders.
// nosemgrep: ajinabraham.njsscan.database.sql_injection.node_sqli_injection
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_ID = 727274; // arbitrary, constant: "GT"

async function connect() {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) throw new Error('DATABASE_OWNER_URL is not set');
  for (let i = 1; ; i++) {
    const client = new Client({ connectionString: url });
    try { await client.connect(); return client; } catch (err) {
      await client.end().catch(() => {});
      if (i >= 90) throw err;
      console.log(`waiting for database (${i}/90): ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function applyMigrations(client) {
  await client.query('create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())');
  const done = new Set((await client.query('select version from schema_migrations')).rows.map((r) => r.version));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    console.log(`applying ${file}`);
    await client.query('begin');
    try {
      // nosemgrep: ajinabraham.njsscan.database.sql_injection.node_sqli_injection
      await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await client.query('insert into schema_migrations (version) values ($1)', [file]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw new Error(`${file} failed: ${err.message}`);
    }
  }
}

function readJson(name, fallback) {
  const p = path.join(DATA_DIR, name);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8')); // a corrupt file throws: better to stop than import half
}

async function importJson(client) {
  const marker = 'import:json-v1';
  if ((await client.query('select 1 from schema_migrations where version = $1', [marker])).rowCount) return;
  const userCount = (await client.query('select count(*)::int as n from users')).rows[0].n;
  const usersFile = path.join(DATA_DIR, 'users.json');
  if (userCount > 0 || !fs.existsSync(usersFile)) {
    console.log(userCount > 0 ? 'import: users already present, skipping JSON import' : `import: no ${usersFile}, nothing to import`);
    await client.query('insert into schema_migrations (version) values ($1)', [marker]);
    return;
  }

  const users = readJson('users.json', []);
  const requests = readJson('requests.json', []);
  const jobs = readJson('downloads.json', []);
  const feeds = readJson('feeds.json', []);
  const providers = readJson('providers.json', []);
  const stats = readJson('stats.json', {});
  const auditPath = path.join(DATA_DIR, 'audit.log');
  const auditLines = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean) : [];

  const bad = users.filter((u) => !/^[A-Za-z0-9_.-]{3,32}$/.test(String(u.username || '')));
  if (bad.length) throw new Error(`import: ${bad.length} username(s) don't fit the new rules; fix users.json first`);

  await client.query('begin');
  try {
    const idByName = new Map();
    for (const u of users) {
      // Keep existing scrypt hashes as they are (upgraded at next login). A plaintext password left
      // over from the very first version gets hashed now, so plaintext never reaches the database.
      const stored = passwords.parse(u.password) ? u.password : await passwords.hash(String(u.password || ''));
      const { rows } = await client.query(
        "insert into users (username, password_hash, role, status) values ($1, $2, $3, 'active') returning id",
        [u.username, stored, u.role === 'admin' ? 'admin' : 'user'],
      );
      idByName.set(u.username.toLowerCase(), rows[0].id);
    }
    for (const r of requests) {
      await client.query(
        `insert into game_requests (id, user_id, requested_by_name, title, platform, input, dedupe_key, status, requested_at, decided_at, decided_by_name, reason, job_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [r.id, idByName.get(String(r.username || '').toLowerCase()) || null, r.username || 'unknown', r.title || 'Untitled request', r.platform || null,
          r.input || {}, dedupeKeyFor(r.input || {}), ['pending', 'approved', 'rejected'].includes(r.status) ? r.status : 'pending',
          r.requestedAt || new Date().toISOString(), r.decidedAt || null, r.decidedBy || null, r.reason || null, r.jobId || null],
      );
    }
    for (const j of jobs) {
      await client.query(
        'insert into download_jobs (id, status, record, scan_skipped, started_at, finished_at) values ($1, $2, $3, $4, $5, $6)',
        [j.id, j.status, j, !!j.scanSkipped, j.startedAt || null, j.finishedAt || null],
      );
    }
    for (const f of feeds) {
      await client.query('insert into feeds (id, url, name, added_at) values ($1, $2, $3, $4)', [f.id, f.url, f.name || f.url, f.addedAt || new Date().toISOString()]);
    }
    for (const p of providers) {
      await client.query(
        'insert into providers (id, name, base_url, api_key_enc, added_at) values ($1, $2, $3, $4, $5)',
        [p.id, p.name, p.baseUrl, secretBox.encrypt(p.apiKey), p.addedAt || new Date().toISOString()],
      );
    }
    for (const [key, v] of Object.entries(stats)) {
      const i = key.indexOf('/');
      if (i < 0) continue;
      await client.query('insert into game_stats (platform, folder, download_count) values ($1, $2, $3)', [key.slice(0, i), key.slice(i + 1), Number(v.downloadCount) || 0]);
    }
    let auditSkipped = 0;
    for (const line of auditLines) {
      let e;
      try { e = JSON.parse(line); } catch { auditSkipped++; continue; }
      const { time, user, ip, action, ...details } = e;
      await client.query('insert into audit_log (at, actor, ip, action, details) values ($1, $2, $3, $4, $5)', [time || new Date().toISOString(), user || null, ip || null, action || 'unknown', details]);
    }
    await client.query("insert into audit_log (actor, action, details) values (null, 'import.json', $1)", [{ users: users.length, requests: requests.length, jobs: jobs.length, feeds: feeds.length, providers: providers.length, auditLines: auditLines.length - auditSkipped }]);
    await client.query('insert into schema_migrations (version) values ($1)', [marker]);
    await client.query('commit');
    console.log(`import: done. users=${users.length} requests=${requests.length} jobs=${jobs.length} feeds=${feeds.length} providers=${providers.length} stats=${Object.keys(stats).length} audit=${auditLines.length - auditSkipped}${auditSkipped ? ` (skipped ${auditSkipped} unreadable audit lines)` : ''}`);
  } catch (err) {
    await client.query('rollback');
    throw new Error(`import failed, nothing was imported: ${err.message}`);
  }
}

async function main() {
  const client = await connect();
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_ID]);
    await applyMigrations(client);
    await importJson(client);
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    await client.end();
  }
}

if (require.main === module) {
  main().then(() => console.log('migrate: ok')).catch((err) => { console.error(`migrate: ${err.message}`); process.exit(1); });
}

module.exports = { main };
