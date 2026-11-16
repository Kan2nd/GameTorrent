#!/usr/bin/env node
/**
 * API-level security tests. Builds a throwaway PostgreSQL database with the PRODUCTION permission
 * model (k8s/postgres/init-roles.sql + webui/db/migrate.js), imports fake legacy JSON files the
 * way the real cutover does, starts the real webui server on 127.0.0.1 against throwaway folders,
 * then attacks it over HTTP the way a logged-in user would. Never touches real data.
 *
 *   TEST_PG_SUPERUSER_URL=postgres://postgres:<pw>@<host>:5432/postgres node cicd/tests/api-selftest.js
 *
 * Run from the repo root after `npm ci` in poc/ and webui/. CI provides Postgres as a service
 * (cicd/.gitlab-ci.yml, test:security). Exits non-zero if any check fails.
 */

'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const { Client } = require(path.join(REPO, 'webui', 'node_modules', 'pg'));

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const rand = () => crypto.randomBytes(12).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SUPER_URL = process.env.TEST_PG_SUPERUSER_URL;
if (!SUPER_URL) { console.error('TEST_PG_SUPERUSER_URL is required'); process.exit(2); }
const pgUrl = (user, pw, dbName) => { const u = new URL(SUPER_URL); u.username = user; u.password = pw; u.pathname = `/${dbName}`; return u.toString(); };
const OWNER_PW = rand();
const APP_PW = rand();
const OWNER_URL = pgUrl('gt_owner', OWNER_PW, 'gametorrent');
const APP_URL = pgUrl('gt_app', APP_PW, 'gametorrent');
const ENC_KEY = crypto.randomBytes(32).toString('hex');

// --- throwaway folders + legacy JSON, shaped exactly like the real webui/data ---
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-api-test-'));
const DATA = path.join(ROOT, 'data');
const ROMS = path.join(ROOT, 'roms');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(ROMS, 'gba', 'testgame'), { recursive: true });
fs.writeFileSync(path.join(ROMS, 'gba', 'testgame', 'game.gba'), 'ROMDATA');
let symlinkMade = false;
try { fs.symlinkSync(path.join(DATA, 'providers.json'), path.join(ROMS, 'gba', 'testgame', 'link.gba')); symlinkMade = true; } catch { /* Windows */ }

const ADMIN = 'testadmin';
const ADMIN_PW = rand();
const LEGACY_PW = rand();
const legacyHash = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`; };
fs.writeFileSync(path.join(DATA, 'users.json'), JSON.stringify([
  { username: ADMIN, password: legacyHash(ADMIN_PW), role: 'admin' },
  { username: 'legacyuser', password: legacyHash(LEGACY_PW), role: 'user' },
  { username: 'plaintextuser', password: 'oldplaintextpassword', role: 'user' }, // from the very first version
]));
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify([{ id: crypto.randomUUID(), name: 'local', baseUrl: 'http://127.0.0.1:1', apiKey: 'CANARY-KEY-123', addedAt: new Date().toISOString() }]));
fs.writeFileSync(path.join(DATA, 'requests.json'), JSON.stringify([{ id: crypto.randomUUID(), username: 'legacyuser', input: { gameId: 'x' }, opts: { skipScan: true }, title: 'Old request', platform: 'gba', status: 'rejected', requestedAt: new Date().toISOString(), reason: 'old' }]));
fs.writeFileSync(path.join(DATA, 'stats.json'), JSON.stringify({ 'gba/testgame': { downloadCount: 7 } }));
fs.writeFileSync(path.join(DATA, 'audit.log'), `${JSON.stringify({ time: new Date().toISOString(), user: ADMIN, ip: '1.2.3.4', action: 'login.success' })}\nnot json\n`);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: path.join(REPO, 'webui'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

/** Builds the test database with the same SQL production uses (init-roles.sql). */
async function setupDatabase() {
  const sup = new Client({ connectionString: SUPER_URL });
  await sup.connect();
  await sup.query('drop database if exists gametorrent with (force)');
  await sup.query('drop role if exists gt_app');
  await sup.query('drop role if exists gt_owner');
  await sup.query('grant connect on database postgres to public'); // init-roles.sql revokes it; reset for reruns
  const sql = fs.readFileSync(path.join(REPO, 'k8s', 'postgres', 'init-roles.sql'), 'utf8')
    .replace(":'owner_pw'", `'${OWNER_PW}'`).replace(":'app_pw'", `'${APP_PW}'`);
  const [beforeConnect, afterConnect] = sql.split('\\connect gametorrent');
  // CREATE DATABASE can't run inside a multi-statement batch, so these go one at a time
  // (comments stripped first: they contain semicolons).
  for (const stmt of beforeConnect.replace(/--.*$/gm, '').split(';').map((x) => x.trim()).filter(Boolean)) await sup.query(stmt);
  await sup.end();
  const sup2 = new Client({ connectionString: pgUrl(new URL(SUPER_URL).username, decodeURIComponent(new URL(SUPER_URL).password), 'gametorrent') });
  await sup2.connect();
  await sup2.query(afterConnect);
  await sup2.end();
}

/** Minimal cookie-keeping client: one per simulated browser. */
function client(base) {
  const jar = new Map();
  return async function req(method, url, { body, headers = {} } = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base() + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, text, json };
  };
}

let PORT;
let server = null;
let serverOut = '';
const BASE = () => `http://127.0.0.1:${PORT}`;
const SERVER_ENV = () => ({
  PORT: String(PORT), SESSION_SECRET: 'fixed-for-restart-test', DATABASE_URL: APP_URL, DATA_ENCRYPTION_KEY: ENC_KEY,
  GT_DATA_DIR: DATA, GT_ROMS_DIR: ROMS, GT_DOWNLOADS_DIR: path.join(ROOT, 'downloads'),
  WEBUI_USER: '', WEBUI_PASSWORD: '', SIGNUP_MODE: 'approval',
  ALLOW_PRIVATE_FETCH: '1', // test only: lets a job download from the local file server below
});

async function startServer() {
  server = spawn(process.execPath, ['server.js'], { cwd: path.join(REPO, 'webui'), env: { ...process.env, ...SERVER_ENV() }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  for (let i = 0; i < 75; i++) {
    try { await fetch(`${BASE()}/login.html`); return; } catch { await sleep(200); }
  }
  throw new Error(`server never came up. Output:\n${serverOut}`);
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  await new Promise((r) => { s.once('close', r); s.kill(); });
}

async function main() {
  PORT = await freePort();
  await setupDatabase();

  // --- migrations + one-time JSON import ---
  const mig = await run(process.execPath, ['db/migrate.js'], { DATABASE_OWNER_URL: OWNER_URL, DATA_ENCRYPTION_KEY: ENC_KEY, GT_DATA_DIR: DATA });
  check('migrate + import succeed', mig.code === 0, mig.code === 0 ? '' : mig.out.slice(-500));
  check('import reports what it copied', /users=3 requests=1/.test(mig.out) && /skipped 1 unreadable audit/.test(mig.out), mig.out.split('\n').find((l) => l.includes('import:')) || '');
  const again = await run(process.execPath, ['db/migrate.js'], { DATABASE_OWNER_URL: OWNER_URL, DATA_ENCRYPTION_KEY: ENC_KEY, GT_DATA_DIR: DATA });
  check('second migrate run is a no-op', again.code === 0 && !again.out.includes('import: done'));

  const appDb = new Client({ connectionString: APP_URL });
  await appDb.connect();
  const ownerDb = new Client({ connectionString: OWNER_URL });
  await ownerDb.connect();
  const hashes = (await ownerDb.query("select username, password_hash from users order by username")).rows;
  check('import: plaintext password was hashed, not stored', hashes.find((r) => r.username === 'plaintextuser').password_hash.startsWith('scrypt$'));
  const enc = (await ownerDb.query('select api_key_enc from providers')).rows[0].api_key_enc;
  check('import: Jackett key stored encrypted (no plaintext in the database)', !!enc && !enc.includes('CANARY'));
  check('import: stats carried over', (await ownerDb.query("select download_count from game_stats where folder = 'testgame'")).rows[0].download_count === 7);

  // --- the database permission model itself ---
  const denied = async (sql) => { try { await appDb.query(sql); return false; } catch (err) { return err.code === '42501'; } };
  check('gt_app cannot UPDATE audit_log', await denied("update audit_log set action = 'x'"));
  check('gt_app cannot DELETE from audit_log', await denied('delete from audit_log'));
  check('gt_app cannot create tables', await denied('create table hacked (x int)'));
  check('gt_app cannot drop tables', await denied('drop table users'));
  check('gt_app can still INSERT into audit_log', (await appDb.query("insert into audit_log (action) values ('test.insert')")).rowCount === 1);
  await appDb.end();

  await startServer();
  const admin = client(BASE);

  // --- login: imported legacy hash works, then gets upgraded ---
  check('imported admin (legacy hash) can log in', (await admin('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PW } })).status === 200);
  const upgraded = (await ownerDb.query('select password_hash from users where username = $1', [ADMIN])).rows[0].password_hash;
  check('legacy hash upgraded to scrypt$ format at login', upgraded.startsWith('scrypt$32768$8$3$'));
  check('imported legacy user can log in', (await client(BASE)('POST', '/api/login', { body: { username: 'legacyuser', password: LEGACY_PW } })).status === 200);
  check('username is case-insensitive at login', (await client(BASE)('POST', '/api/login', { body: { username: ADMIN.toUpperCase(), password: ADMIN_PW } })).status === 200);
  check('providers API never returns the key', !(await admin('GET', '/api/providers')).text.includes('CANARY'));

  // --- sign-up (SIGNUP_MODE=approval) ---
  const SIGN_PW = rand();
  const signup = await client(BASE)('POST', '/api/signup', { body: { username: 'newplayer', password: SIGN_PW, role: 'admin' } });
  check('sign-up accepted, pending', signup.status === 200 && signup.json.status === 'pending');
  check('sign-up with a taken username (any case) refused', (await client(BASE)('POST', '/api/signup', { body: { username: 'NEWPLAYER', password: rand() } })).status === 409);
  check('sign-up with a short password refused', (await client(BASE)('POST', '/api/signup', { body: { username: 'shorty', password: 'a'.repeat(11) } })).status === 400);
  const newbie = client(BASE);
  const pendingLogin = await newbie('POST', '/api/login', { body: { username: 'newplayer', password: SIGN_PW } });
  check('pending account cannot log in yet', pendingLogin.status === 403 && /approve/.test(pendingLogin.json.error));
  check('wrong password on a pending account looks like any wrong password', (await client(BASE)('POST', '/api/login', { body: { username: 'newplayer', password: 'wrong-wrong-wrong' } })).status === 401);
  let users = (await admin('GET', '/api/users')).json;
  const np = users.find((u) => u.username === 'newplayer');
  check('sign-up is a standard user even if it asked for admin', np && np.role === 'user' && np.status === 'pending');
  check('admin approves the sign-up', (await admin('PATCH', `/api/users/${np.id}`, { body: { status: 'active' } })).status === 200);
  check('approved account can log in', (await newbie('POST', '/api/login', { body: { username: 'newplayer', password: SIGN_PW } })).status === 200);

  // --- #1 path traversal (also re-checked here against the DB-backed server) ---
  const dl = (q) => newbie('GET', `/api/installed/file?${q}`);
  check('#1 control: a real ROM downloads', (await dl('platform=gba&folder=testgame&file=game.gba')).text === 'ROMDATA');
  const attack = await dl('platform=..&folder=data&file=providers.json');
  check('#1 refused over HTTP: platform=..&folder=data', attack.status === 404 && !attack.text.includes('CANARY'), `HTTP ${attack.status}`);
  process.env.GT_ROMS_DIR = ROMS;
  const { resolveInstalledFile } = require(path.join(REPO, 'webui', 'lib', 'library'));
  for (const [pl, fo, fi] of [['..', 'data', 'providers.json'], ['gba', '..', '../data/providers.json'], ['gba', 'testgame', '../../../data/providers.json'],
    ['../..', 'data', 'providers.json'], ['gba', 'testgame', '..\\..\\..\\data\\providers.json'], ['.', 'data', 'providers.json'],
    ['gba/../..', 'data', 'providers.json'], ['gba', 'testgame', path.join(DATA, 'providers.json')]]) {
    check(`#1 resolver refuses ${JSON.stringify([pl, fo, fi])}`, resolveInstalledFile(pl, fo, fi) === null);
  }
  if (symlinkMade) check('#1 resolver refuses a symlink pointing outside roms/', resolveInstalledFile('gba', 'testgame', 'link.gba') === null);
  else console.log('SKIP  #1 symlink check (no symlink rights on this OS; runs in CI on Linux)');

  // --- CSRF / Origin guard ---
  check('cross-site Origin refused', (await newbie('POST', '/api/account/logout-everywhere', { headers: { origin: 'http://evil.example' } })).status === 403);
  check('Sec-Fetch-Site: cross-site refused', (await newbie('DELETE', `/api/requests/${crypto.randomUUID()}`, { headers: { 'sec-fetch-site': 'cross-site' } })).status === 403);

  // --- request -> approve -> download, end to end ---
  const files = http.createServer((req, res) => res.end('SHAREDROM')).listen(0, '127.0.0.1');
  await new Promise((r) => files.once('listening', r));
  const directUrl = `http://127.0.0.1:${files.address().port}/shared.gba`;
  const input = { directUrl, platform: 'gba', destSubfolder: 'shared-game', archiveFormat: 'none' };
  const r1 = await newbie('POST', '/api/downloads', { body: { ...input, skipScan: true, noVt: true, launch: true } });
  check('#4 standard user download becomes a request', r1.status === 200 && r1.json.requested === true);
  const legacy = client(BASE);
  await legacy('POST', '/api/login', { body: { username: 'legacyuser', password: LEGACY_PW } });
  const r2 = await legacy('POST', '/api/downloads', { body: input });
  const stored = (await ownerDb.query('select input from game_requests where id = $1', [r1.json.request.id])).rows[0].input;
  check('#4 stored request has no scan/launch options', !('skipScan' in stored) && !('launch' in stored) && !('noVt' in stored), JSON.stringify(stored));
  // Two admins approve the two duplicate requests at the same instant: exactly one download.
  const admin2PW = rand();
  await admin('POST', '/api/users', { body: { username: 'admin2', password: admin2PW, role: 'admin', mustChangePassword: false } });
  const admin2 = client(BASE);
  await admin2('POST', '/api/login', { body: { username: 'admin2', password: admin2PW } });
  const [a1, a2] = await Promise.all([
    admin('POST', `/api/requests/${r1.json.request.id}/approve`, { body: { skipScan: true, noVt: true } }),
    admin2('POST', `/api/requests/${r2.json.request.id}/approve`, { body: { skipScan: true, noVt: true } }),
  ]);
  const okOnes = [a1, a2].filter((r) => r.status === 200);
  check('concurrent approvals of duplicates: exactly one succeeds', okOnes.length === 1, `${a1.status}/${a2.status}`);
  check('the winner reports the duplicate as also approved', okOnes[0] && okOnes[0].json.alsoApproved === 1);
  const jobId = okOnes[0] && okOnes[0].json.job.id;
  let job = null;
  for (let i = 0; i < 60; i++) {
    job = (await admin('GET', `/api/downloads/${jobId}`)).json;
    if (job && (job.status === 'done' || job.status === 'error')) break;
    await sleep(500);
  }
  check('approved job finishes', job && job.status === 'done', job ? `${job.status} ${job.error || ''}` : 'no job');
  files.close();
  const mine = (await newbie('GET', '/api/downloads')).json;
  check('#11 requester sees their job, without logs', mine.length === 1 && mine[0].id === jobId && mine[0].logs.length === 0);
  const intruderPW = rand();
  await admin('POST', '/api/users', { body: { username: 'intruder', password: intruderPW, mustChangePassword: false } });
  const intruder = client(BASE);
  await intruder('POST', '/api/login', { body: { username: 'intruder', password: intruderPW } });
  check('#11 another user sees none of it', (await intruder('GET', '/api/downloads')).json.length === 0);
  check('#11 ...not even by id', (await intruder('GET', `/api/downloads/${jobId}`)).status === 404);
  const installed = (await newbie('GET', '/api/installed')).json;
  check('skipped scan shows up as UNSCANNED in the library', installed.some((g) => g.folder === 'shared-game' && g.scanSkipped === true));
  // --- a download whose console could not be named is KEPT as "unknown"; an admin names the console later ---
  fs.mkdirSync(path.join(ROMS, 'unknown', 'mystery-pack'), { recursive: true });
  fs.writeFileSync(path.join(ROMS, 'unknown', 'mystery-pack', 'blob.dat'), 'UNKNOWNDATA');
  const listed = (await newbie('GET', '/api/installed')).json.find((g) => g.folder === 'mystery-pack');
  check('an "unknown" install shows in the library, with its file offered', listed && listed.platform === 'unknown' && listed.romFiles.length === 1);
  check('...and it downloads', (await dl('platform=unknown&folder=mystery-pack&file=blob.dat')).text === 'UNKNOWNDATA');
  check('only an admin can name the console', (await newbie('POST', '/api/installed/unknown/mystery-pack/platform', { body: { platform: 'nds' } })).status === 403);
  check('a bad platform id is refused', (await admin('POST', '/api/installed/unknown/mystery-pack/platform', { body: { platform: '../x' } })).status === 400);
  check('a traversal in the folder is refused', (await admin('POST', '/api/installed/unknown/..%2Fdata/platform', { body: { platform: 'nds' } })).status >= 400);
  check('admin names the console', (await admin('POST', '/api/installed/unknown/mystery-pack/platform', { body: { platform: 'nds' } })).status === 200);
  const moved = (await newbie('GET', '/api/installed')).json.find((g) => g.folder === 'mystery-pack');
  check('...and the game is now filed under it', moved && moved.platform === 'nds' && !fs.existsSync(path.join(ROMS, 'unknown', 'mystery-pack')));
  check('...the old empty platform folder is tidied away', !fs.existsSync(path.join(ROMS, 'unknown')));
  // --- editing a provider (fixing its URL) without re-typing the key ---
  const provList = (await admin('GET', '/api/providers')).json;
  const prov = provList[0];
  const encBefore = (await ownerDb.query('select api_key_enc from providers where id = $1', [prov.id])).rows[0].api_key_enc;
  check('only an admin can edit a provider', (await newbie('PATCH', `/api/providers/${prov.id}`, { body: { baseUrl: 'http://jackett:9117' } })).status === 403);
  check('an empty edit is refused', (await admin('PATCH', `/api/providers/${prov.id}`, { body: {} })).status === 400);
  check('a non-http URL is refused', (await admin('PATCH', `/api/providers/${prov.id}`, { body: { baseUrl: 'file:///etc/passwd' } })).status === 400);
  check('an unknown provider is a 404', (await admin('PATCH', '/api/providers/00000000-0000-4000-8000-000000000000', { body: { baseUrl: 'http://jackett:9117' } })).status === 404);
  const edited = await admin('PATCH', `/api/providers/${prov.id}`, { body: { baseUrl: 'http://jackett:9117/' } });
  check('admin changes the URL (trailing slash dropped)', edited.status === 200 && edited.json.baseUrl === 'http://jackett:9117' && edited.json.name === prov.name);
  const encAfter = (await ownerDb.query('select api_key_enc from providers where id = $1', [prov.id])).rows[0].api_key_enc;
  check('...and the saved key is untouched', encBefore === encAfter);
  check('...the response and the list never show the key', !edited.text.includes('CANARY') && !(await admin('GET', '/api/providers')).text.includes('CANARY'));
  const upd = (await ownerDb.query("select details from audit_log where action = 'provider.update'")).rows;
  check('the edit is in the audit log, without the key', upd.length >= 1 && !JSON.stringify(upd).includes('CANARY'));
  check('the "looking for" choices are served', ((await newbie('GET', '/api/search/kinds')).json || []).some((k) => k.id === 'nds'));
  check('a user cannot delete someone else\'s request', (await intruder('DELETE', `/api/requests/${r1.json.request.id}`)).status === 403);
  const auditRows = (await ownerDb.query("select details from audit_log where action = 'request.approve'")).rows;
  check('approval with skipped scan is in the audit log', auditRows.some((r) => r.details.skippedClamAV === true));

  // --- #2 revocation: disable, demote, delete, reset ---
  check('admin disables a user', (await admin('PATCH', `/api/users/${np.id}`, { body: { status: 'disabled' } })).status === 200);
  check('#2 disabled user session is dead immediately', (await newbie('GET', '/api/downloads')).status === 401);
  check('#2 disabled user cannot log back in', (await client(BASE)('POST', '/api/login', { body: { username: 'newplayer', password: SIGN_PW } })).status === 403);
  users = (await admin('GET', '/api/users')).json;
  const a2row = users.find((u) => u.username === 'admin2');
  check('admin demotes admin2', (await admin('PATCH', `/api/users/${a2row.id}`, { body: { role: 'user' } })).status === 200);
  check('#2 demoted admin loses admin access at once', (await admin2('GET', '/api/users')).status === 401);
  const inRow = users.find((u) => u.username === 'intruder');
  check('admin deletes a user', (await admin('DELETE', `/api/users/${inRow.id}`)).status === 200);
  check('#2 deleted user session is dead', (await intruder('GET', '/api/downloads')).status === 401);

  // --- forced password change after an admin reset ---
  const legacyRow = users.find((u) => u.username === 'legacyuser');
  const TEMP = rand();
  check('admin resets a password', (await admin('POST', `/api/users/${legacyRow.id}/password`, { body: { password: TEMP } })).status === 200);
  check('reset ends the old session', (await legacy('GET', '/api/downloads')).status === 401);
  await legacy('POST', '/api/login', { body: { username: 'legacyuser', password: TEMP } });
  const blocked = await legacy('GET', '/api/downloads');
  check('temporary password: everything blocked until changed', blocked.status === 403 && blocked.json.mustChangePassword === true);
  const NEWPW = rand();
  check('user sets their own password', (await legacy('POST', '/api/account/password', { body: { currentPassword: TEMP, newPassword: NEWPW } })).status === 200);
  check('...and is unblocked', (await legacy('GET', '/api/downloads')).status === 200);
  check('wrong current password refused', (await legacy('POST', '/api/account/password', { body: { currentPassword: 'nope-nope-nope', newPassword: rand() } })).status === 400);

  // --- last-admin guard, including the race ---
  users = (await admin('GET', '/api/users')).json;
  const me = users.find((u) => u.username === ADMIN);
  check("admin can't delete themselves", (await admin('DELETE', `/api/users/${me.id}`)).status === 400);
  await admin('PATCH', `/api/users/${a2row.id}`, { body: { role: 'admin' } });
  await admin2('POST', '/api/login', { body: { username: 'admin2', password: admin2PW } });
  const [d1, d2] = await Promise.all([
    admin('PATCH', `/api/users/${a2row.id}`, { body: { role: 'user' } }),
    admin2('PATCH', `/api/users/${me.id}`, { body: { role: 'user' } }),
  ]);
  const admins = (await ownerDb.query("select count(*)::int as n from users where role = 'admin' and status = 'active'")).rows[0].n;
  check('two admins demoting each other at once: one admin always remains', admins >= 1, `statuses ${d1.status}/${d2.status}, admins left ${admins}`);

  // --- sessions survive a restart (they live in Postgres now) ---
  const survivor = admins && (d1.status === 200 ? admin : admin2);
  await stopServer();
  await startServer();
  check('session survives a server restart', (await survivor('GET', '/api/users')).status === 200);

  // --- #3 lockout: attacker can't lock out the real user's browser ---
  const attacker = client(BASE);
  const victim = d1.status === 200 ? ADMIN : 'admin2';
  const victimPw = d1.status === 200 ? ADMIN_PW : admin2PW;
  for (let i = 0; i < 5; i++) await attacker('POST', '/api/login', { body: { username: victim, password: 'wrong-guess' } });
  check('#3 attacker is limited after 5 failures', (await attacker('POST', '/api/login', { body: { username: victim, password: 'wrong-guess' } })).status === 429);
  check('#3 a new browser is limited too for that account', (await client(BASE)('POST', '/api/login', { body: { username: victim, password: victimPw } })).status === 429);
  check('#3 the real user\'s own browser (device cookie) still gets in', (await survivor('POST', '/api/login', { body: { username: victim, password: victimPw } })).status === 200);
  const burst = await Promise.all(Array.from({ length: 20 }, () => client(BASE)('POST', '/api/login', { body: { username: 'burst-target', password: 'x' } })));
  check('#3 20 parallel guesses: at most 5 checked', burst.filter((r) => r.status === 401).length <= 5);

  check('audit events go to stdout too', serverOut.includes('"type":"audit"'));
  check('no 500s during the run', !/failed: (Error|error)/.test(serverOut), (serverOut.match(/.*failed:.*/) || [''])[0].slice(0, 200));

  await ownerDb.end();
}

main()
  .catch((err) => { failures++; console.error(err); })
  .finally(async () => {
    await stopServer();
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
    process.exit(failures ? 1 : 0);
  });
