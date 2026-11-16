#!/usr/bin/env node
/**
 * GameTorrent web UI. Thin HTTP layer over poc/pipeline.js. State lives in PostgreSQL
 * (db/, lib/*.js); see docs/WEBUI.md for setup (required env vars) and the API.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');

const pipeline = require('../poc/pipeline');
const db = require('./db');
const auth = require('./lib/auth');
const feeds = require('./lib/feeds');
const downloads = require('./lib/downloadManager');
const providers = require('./lib/providers');
const searchKinds = require('./lib/searchKinds');
const library = require('./lib/library');
const coverArt = require('./lib/coverArt');
const stats = require('./lib/stats');
const requests = require('./lib/requests');
const secretBox = require('./lib/secretBox');
const { PgSessionStore } = require('./lib/sessionStore');
const { HttpError, badRequest, notFound } = require('./lib/errors');
const {
  downloadRateLimiter, loginRateLimiter, recordLoginFailure, recordLoginSuccess, configureLoginLimiter, signupRateLimiter,
} = require('./lib/rateLimit');
const { audit } = require('./lib/audit');

const { requireAuth, requireAdmin } = auth;

const PORT = process.env.PORT || 3000;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set: using a random one for this run; everyone will be logged out on restart.');
}
configureLoginLimiter({ secret: sessionSecret, secure: COOKIE_SECURE });

/** Wraps an async route so a rejected promise reaches the error handler instead of hanging. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const app = express();
// Which proxies may set X-Forwarded-For. Default: none. Nothing sits in front of this app, so
// trusting the header would let any client invent its own IP: dodging the rate limits and
// poisoning the audit log. If a reverse proxy is ever added, set TRUST_PROXY to its address.
app.set('trust proxy', process.env.TRUST_PROXY || false);

// Security headers. CSP: scripts only from this origin (no inline script anywhere in public/),
// inline styles allowed (a few computed style="" attributes), images also from https: hosts
// because cover art comes from libretro/RAWG. frame-ancestors 'none' stops clickjacking.
// upgradeInsecureRequests is off because the app is served over plain HTTP on the LAN.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'https:'],
      'font-src': ["'self'"],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': null,
    },
  },
  // HSTS only makes sense over HTTPS; set COOKIE_SECURE=1 once the UI is behind TLS.
  strictTransportSecurity: COOKIE_SECURE,
}));

// Cross-site request guard for anything that changes state. The session cookie is SameSite=Lax,
// which already stops most cross-site POSTs; this is the second lock. Browsers always send Origin
// (and Sec-Fetch-Site) on POST/PATCH/DELETE, so a request from another site is refused here.
// Requests with neither header (curl, scripts) can't carry a victim's browser cookie, so they pass.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Cross-site request refused' });
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* "null" or garbage */ }
    if (host !== req.get('host')) return res.status(403).json({ error: 'Cross-site request refused' });
  }
  next();
});

app.use(express.json({ limit: '100kb' }));

// Sessions live in PostgreSQL (lib/sessionStore.js), so they survive restarts and can be revoked
// per user. 8 hours idle (the expiry slides forward on each request: rolling), and at most
// 7 days after login however active (checked in lib/auth.js).
app.use(session({
  store: new PgSessionStore(),
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  name: 'gt.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: COOKIE_SECURE, // plain HTTP on the LAN today; COOKIE_SECURE=1 once served over HTTPS
    maxAge: 8 * 60 * 60 * 1000,
  },
}));

// --- Public: login, sign-up, session info ---

app.post('/api/login', loginRateLimiter, ah(async (req, res) => {
  const { username, password } = req.body || {};
  const result = await auth.authenticate(username, password);
  if (!result.user) {
    recordLoginFailure(req);
    audit(req, 'login.failure', { attemptedUser: String(username || '').slice(0, 64), reason: result.reason });
    // pending/disabled are only ever reported after the correct password was given.
    if (result.reason === 'pending') return res.status(403).json({ error: 'Your account is waiting for an admin to approve it.' });
    if (result.reason === 'disabled') return res.status(403).json({ error: 'This account has been disabled. Ask the admin.' });
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const { user } = result;
  // New session id on login, so a session id planted before login can't be reused after (session fixation).
  await new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
  req.session.authenticated = true;
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.loginAt = Date.now();
  recordLoginSuccess(req, res, user.username);
  audit(req, 'login.success', { trustedDevice: !!(req.loginContext && req.loginContext.trusted) });
  res.json({ ok: true, role: user.role, username: user.username, mustChangePassword: user.mustChangePassword });
}));

app.post('/api/signup', signupRateLimiter, ah(async (req, res) => {
  const { username, password } = req.body || {};
  const created = await auth.signup({ username, password });
  audit(req, 'user.signup', { target: created.username, status: created.status });
  res.json({ ok: true, status: created.status });
}));

app.post('/api/logout', (req, res) => {
  audit(req, 'logout');
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', ah(async (req, res) => {
  const user = await auth.refreshSessionUser(req);
  res.json({
    authenticated: !!user,
    role: user ? user.role : null,
    username: user ? user.username : null,
    mustChangePassword: user ? user.mustChangePassword : false,
    signupMode: auth.signupMode(),
  });
}));

// --- Static assets (no sensitive data in these: safe to serve pre-auth) ---
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', ah(async (req, res) => {
  if (await auth.refreshSessionUser(req)) res.sendFile(path.join(__dirname, 'public', 'index.html'));
  else res.redirect('/login.html');
}));

// --- API (everything below requires a logged-in session) ---
app.use('/api', requireAuth);

// --- My account ---

app.post('/api/account/password', ah(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  await auth.changeOwnPassword(req.user.id, currentPassword, newPassword, req.sessionID);
  req.session.mustChangePassword = false;
  audit(req, 'account.password_change');
  res.json({ ok: true });
}));

app.post('/api/account/logout-everywhere', ah(async (req, res) => {
  await auth.endSessionsFor(req.user.id, req.sessionID);
  audit(req, 'account.logout_everywhere');
  res.json({ ok: true });
}));

// --- Catalog, feeds, providers, search ---

app.get('/api/games', ah(async (req, res) => {
  const { games, warnings } = await feeds.getCombinedCatalog();
  res.json({ games, warnings });
}));

app.get('/api/emulators', (req, res) => {
  res.json(pipeline.loadEmulators());
});

app.get('/api/feeds', ah(async (req, res) => {
  res.json(await feeds.loadFeeds());
}));

app.post('/api/feeds', requireAdmin, ah(async (req, res) => {
  let feed;
  try { feed = await feeds.addFeed((req.body || {}).url, req.user.username); } catch (err) { throw badRequest(err.message); }
  audit(req, 'feed.add', { url: feed.url });
  res.json(feed);
}));

app.delete('/api/feeds/:id', requireAdmin, ah(async (req, res) => {
  await feeds.removeFeed(req.params.id);
  audit(req, 'feed.remove', { id: req.params.id });
  res.json({ ok: true });
}));

app.get('/api/providers', ah(async (req, res) => {
  res.json(await providers.listProviders());
}));

app.post('/api/providers', requireAdmin, ah(async (req, res) => {
  let provider;
  try { provider = await providers.addProvider(req.body || {}, req.user.username); } catch (err) {
    if (err instanceof Error && !err.code) throw badRequest(err.message);
    throw err;
  }
  audit(req, 'provider.add', { name: provider.name, baseUrl: provider.baseUrl });
  res.json(provider);
}));

// Edit a provider without deleting it: { name?, baseUrl?, apiKey? }. Leave apiKey out to keep the saved key.
app.patch('/api/providers/:id', requireAdmin, ah(async (req, res) => {
  let provider;
  try { provider = await providers.updateProvider(req.params.id, req.body || {}); } catch (err) {
    if (err instanceof Error && !err.code) throw badRequest(err.message);
    throw err;
  }
  if (!provider) throw notFound('Provider not found');
  const body = req.body || {};
  audit(req, 'provider.update', { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, keyChanged: !!body.apiKey });
  res.json(provider);
}));

app.delete('/api/providers/:id', requireAdmin, ah(async (req, res) => {
  await providers.removeProvider(req.params.id);
  audit(req, 'provider.remove', { id: req.params.id });
  res.json({ ok: true });
}));

// The "looking for" choices (consoles and file kinds) the Search tab offers next to the game name.
app.get('/api/search/kinds', (req, res) => res.json(searchKinds.listKinds()));

app.get('/api/search', ah(async (req, res) => {
  const { providerId, q } = req.query;
  const kinds = searchKinds.parseKinds(req.query.kinds);
  try {
    if (providerId) {
      res.json(await providers.searchProvider(String(providerId), String(q || ''), kinds));
    } else {
      // No provider chosen: search every configured provider ("All providers").
      res.json(await providers.searchAllProviders(String(q || ''), kinds));
    }
  } catch (err) {
    if (err.code) throw err; // database error: 500, not shown to the user
    throw badRequest(err.message);
  }
}));

app.get('/api/discover', ah(async (req, res) => {
  const installed = downloads.getInstalledMagnets();
  res.json(await providers.discoverAllProviders(installed));
}));

// --- Downloads and the library ---

// Admins see every job. A standard user sees only the jobs started for their own requests, and
// without the log lines (those can include other people's magnets/paths).
async function visibleJobsFor(req) {
  const all = downloads.listJobs();
  if (req.user.role === 'admin') return all;
  const mine = new Set((await requests.listRequestsForUser(req.user.id)).map((r) => r.jobId).filter(Boolean));
  return all.filter((j) => mine.has(j.id)).map(({ logs, ...rest }) => ({ ...rest, logs: [] }));
}

app.get('/api/downloads', ah(async (req, res) => {
  res.json(await visibleJobsFor(req));
}));

app.get('/api/installed', ah(async (req, res) => {
  const installed = library.listInstalled(downloads.listFinishedJobs());
  const counts = await stats.getAllCounts();
  await Promise.all(installed.map(async (item) => {
    item.coverImage = await providers.lookupCover(item.title, item.platform);
    item.downloadCount = counts[`${item.platform}/${item.folder}`] || 0;
  }));
  res.json(installed);
}));

// Streams one installed file to the browser as a download (the user's own copy of the ROM).
app.get('/api/installed/file', downloadRateLimiter, ah(async (req, res) => {
  const target = library.resolveInstalledFile(req.query.platform, req.query.folder, req.query.file);
  if (!target) throw notFound('File not found');
  await stats.incrementDownload(req.query.platform, req.query.folder);
  audit(req, 'game.download', { platform: String(req.query.platform), folder: String(req.query.folder) });
  res.download(target, path.basename(target));
}));

// Admin-only: delete an installed game completely from disk.
app.delete('/api/installed/:platform/:folder', requireAdmin, ah(async (req, res) => {
  let platform; let folder;
  try {
    platform = pipeline.assertSafeName(req.params.platform, 'platform');
    folder = pipeline.assertSafeName(req.params.folder, 'folder');
  } catch (err) { throw badRequest(err.message); }
  const targetDir = path.resolve(pipeline.ROMS_DIR, platform, folder);
  if (!targetDir.startsWith(path.resolve(pipeline.ROMS_DIR) + path.sep)) throw badRequest('Invalid path');
  if (!fs.existsSync(targetDir)) throw notFound('Game not found');
  fs.rmSync(targetDir, { recursive: true, force: true });
  await stats.removeStats(platform, folder);
  audit(req, 'game.delete', { platform, folder });
  res.json({ ok: true });
}));

// Admin-only: name the console of an installed game (typically one kept as "unknown") by moving its folder
// from roms/<old>/<folder> to roms/<new>/<folder>.
app.post('/api/installed/:platform/:folder/platform', requireAdmin, ah(async (req, res) => {
  let oldPlatform; let folder; let newPlatform;
  try {
    oldPlatform = pipeline.assertSafeName(req.params.platform, 'platform');
    folder = pipeline.assertSafeName(req.params.folder, 'folder');
    newPlatform = String((req.body && req.body.platform) || '').trim().toLowerCase();
    if (!/^[a-z0-9]{1,20}$/.test(newPlatform) || newPlatform === 'auto') throw new Error('Pick a platform');
  } catch (err) { throw badRequest(err.message); }
  if (newPlatform === oldPlatform) throw badRequest('That is already its platform');
  const roms = path.resolve(pipeline.ROMS_DIR);
  const from = path.resolve(roms, oldPlatform, folder);
  const to = path.resolve(roms, newPlatform, folder);
  if (!from.startsWith(roms + path.sep) || !to.startsWith(roms + path.sep)) throw badRequest('Invalid path');
  if (!fs.existsSync(from)) throw notFound('Game not found');
  if (fs.existsSync(to)) throw badRequest(`There is already a "${folder}" under ${newPlatform}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  try { fs.rmdirSync(path.dirname(from)); } catch { /* the old platform folder still has other games */ }
  await stats.movePlatform(oldPlatform, newPlatform, folder);
  downloads.reassignPlatform(oldPlatform, newPlatform, folder, from, to);
  audit(req, 'game.platform', { folder, from: oldPlatform, to: newPlatform });
  res.json({ ok: true, platform: newPlatform });
}));

// Clears every finished job's log entry (running jobs are untouched).
app.delete('/api/downloads', requireAdmin, (req, res) => {
  const removed = downloads.clearFinished();
  audit(req, 'jobs.clear', { removed });
  res.json({ removed });
});

// Deletes one job's log entry; a still-running job is cancelled first. Never touches downloaded files.
app.delete('/api/downloads/:id', requireAdmin, (req, res) => {
  try {
    downloads.deleteJob(req.params.id);
  } catch (err) { throw notFound(err.message); }
  audit(req, 'job.delete', { jobId: req.params.id });
  res.json({ ok: true });
});

app.get('/api/downloads/:id', ah(async (req, res) => {
  const job = (await visibleJobsFor(req)).find((j) => j.id === req.params.id);
  if (!job) throw notFound('Job not found');
  res.json(job);
}));

/** Only these options exist; anything else in the body is ignored. Only ever read from an admin. */
function scanOptionsFrom(body) {
  const b = body || {};
  return { skipScan: b.skipScan === true, requireScan: b.requireScan === true, noVt: b.noVt === true, launch: b.launch === true };
}

/** For the audit trail: which safety checks an admin chose to skip (empty object if none). */
function skippedChecks(opts) {
  const out = {};
  if (opts.skipScan) out.skippedClamAV = true;
  if (opts.noVt) out.skippedVirusTotal = true;
  return out;
}

// Standard users don't start downloads directly: this is a "provider" setup where one admin runs
// the server for other people, so a non-admin's Download click files a request instead
// (lib/requests.js) and waits for the admin to approve it.
app.post('/api/downloads', ah(async (req, res) => {
  const { gameId, title, magnetUri, directUrl, platform, destSubfolder, romFile, selectPatterns, excludeTypes, archiveFormat, sha256, emulatorId } = req.body || {};
  const opts = scanOptionsFrom(req.body);
  const input = gameId
    ? { gameId }
    : { title, magnetUri, directUrl, platform, destSubfolder, romFile, selectPatterns, excludeTypes, archiveFormat, sha256, emulatorId };

  let catalogGames = null;
  let displayTitle = title;
  let displayPlatform = platform;
  if (gameId) {
    const combined = await feeds.getCombinedCatalog();
    catalogGames = combined.games;
    const catalogGame = combined.games.find((g) => g.id === gameId);
    if (catalogGame) { displayTitle = catalogGame.title; displayPlatform = catalogGame.platform; }
  }

  if (req.user.role !== 'admin') {
    // Validate now (folder names, platform, source present) so a malformed request is refused up
    // front instead of sitting in the admin's queue looking harmless.
    try {
      if (gameId) {
        if (!catalogGames.some((g) => g.id === gameId)) throw new Error(`Game id "${gameId}" not found`);
      } else {
        pipeline.buildJobFromParams(input);
      }
    } catch (err) { throw badRequest(err.message); }
    // No scan/launch options on a request, whatever the client sent: those are the admin's call
    // at approval time.
    const request = await requests.createRequest(req.user, input, { title: displayTitle, platform: displayPlatform });
    audit(req, 'request.create', { requestId: request.id, title: request.title });
    return res.json({ requested: true, request });
  }

  let job;
  try { job = downloads.startDownload(input, opts, catalogGames); } catch (err) { throw badRequest(err.message); }
  audit(req, 'download.start', { jobId: job.id, title: job.title, source: gameId ? 'catalog' : magnetUri ? 'magnet' : 'url', ...skippedChecks(opts) });
  res.json(job);
}));

// --- Game requests (standard users file these; admins decide) ---

app.get('/api/requests/mine', ah(async (req, res) => {
  res.json(await requests.listRequestsForUser(req.user.id));
}));

app.get('/api/requests', requireAdmin, ah(async (req, res) => {
  const all = await requests.listRequests();
  await Promise.all(all.map(async (r) => { r.coverImage = await providers.lookupCover(r.title, r.platform).catch(() => null); }));
  res.json(all);
}));

app.post('/api/requests/:id/approve', requireAdmin, ah(async (req, res) => {
  const request = await requests.getRequest(req.params.id);
  if (!request) throw notFound('Request not found');
  if (request.status !== 'pending') throw badRequest('This request was already decided');

  // Claim first (atomic in the database): this request plus every other pending request for the
  // same game. If someone else approved it a moment ago, nothing is claimed and no download starts.
  const claimed = await requests.claimWithSiblings(request, req.user.username);
  if (!claimed.length) throw badRequest('This request was already decided');

  const opts = scanOptionsFrom(req.body); // the approving admin's choice, never the stored request's
  let job;
  try {
    // Someone else's request for this exact magnet may already be downloading (or finished):
    // reuse that job instead of fetching the same torrent a second time.
    job = request.input.magnetUri ? downloads.findJobByMagnet(request.input.magnetUri) : null;
    if (!job) {
      const catalogGames = request.input.gameId ? (await feeds.getCombinedCatalog()).games : null;
      job = downloads.startDownload(request.input, opts, catalogGames);
    }
  } catch (err) {
    await requests.unclaim(claimed);
    throw badRequest(err.message);
  }
  await requests.linkJob(claimed, job.id);
  const alsoApproved = claimed.filter((id) => id !== request.id);
  audit(req, 'request.approve', { requestId: request.id, jobId: job.id, alsoApproved, ...skippedChecks(opts) });
  res.json({ ok: true, job, alsoApproved: alsoApproved.length });
}));

app.post('/api/requests/:id/reject', requireAdmin, ah(async (req, res) => {
  const request = await requests.getRequest(req.params.id);
  if (!request) throw notFound('Request not found');
  if (!(await requests.rejectRequest(request.id, (req.body && req.body.reason) || null, req.user.username))) {
    throw badRequest('This request was already decided');
  }
  audit(req, 'request.reject', { requestId: request.id });
  res.json({ ok: true });
}));

// A user can cancel their own still-pending request; an admin can remove any request record.
app.delete('/api/requests/:id', ah(async (req, res) => {
  const request = await requests.getRequest(req.params.id);
  if (!request) throw notFound('Request not found');
  const isAdmin = req.user.role === 'admin';
  const isOwner = request.userId !== null && request.userId === req.user.id;
  if (!isOwner && !isAdmin) throw new HttpError(403, 'Not your request');
  if (!isAdmin && request.status !== 'pending') throw badRequest('Only a still-pending request can be cancelled');
  await requests.deleteRequest(request.id);
  audit(req, 'request.delete', { requestId: request.id, owner: request.username });
  res.json({ ok: true });
}));

// --- User management (admin only) ---

function userIdParam(req) {
  if (!/^\d{1,18}$/.test(req.params.id)) throw notFound('User not found');
  return Number(req.params.id);
}

app.get('/api/users', requireAdmin, ah(async (req, res) => {
  res.json(await auth.listUsers());
}));

app.post('/api/users', requireAdmin, ah(async (req, res) => {
  const { username, password, role, mustChangePassword } = req.body || {};
  const created = await auth.createUser({ username, password, role, mustChangePassword: mustChangePassword !== false }, req.user);
  audit(req, 'user.create', { target: created.username, role: created.role });
  res.json(created);
}));

// { role } and/or { status: 'active' | 'disabled' }. Approving a sign-up = status 'active'.
app.patch('/api/users/:id', requireAdmin, ah(async (req, res) => {
  const { role, status } = req.body || {};
  const { user, approved } = await auth.updateUser(userIdParam(req), { role, status }, req.user);
  audit(req, approved ? 'user.approve' : 'user.update', { target: user.username, role: user.role, status: user.status });
  res.json(user);
}));

app.post('/api/users/:id/password', requireAdmin, ah(async (req, res) => {
  const id = userIdParam(req);
  await auth.resetPassword(id, (req.body || {}).password, req.user);
  const target = await auth.getUser(id);
  audit(req, 'user.password_reset', { target: target && target.username });
  res.json({ ok: true });
}));

app.post('/api/users/:id/logout', requireAdmin, ah(async (req, res) => {
  const id = userIdParam(req);
  const target = await auth.getUser(id);
  if (!target) throw notFound('User not found');
  await auth.endSessionsFor(id, id === req.user.id ? req.sessionID : null);
  audit(req, 'user.logout', { target: target.username });
  res.json({ ok: true });
}));

app.delete('/api/users/:id', requireAdmin, ah(async (req, res) => {
  const removed = await auth.deleteUser(userIdParam(req), req.user);
  audit(req, 'user.delete', { target: removed.username });
  res.json({ ok: true });
}));

app.post('/api/downloads/:id/launch', requireAdmin, (req, res) => {
  try {
    downloads.launchJob(req.params.id);
  } catch (err) { throw badRequest(err.message); }
  audit(req, 'emulator.launch', { jobId: req.params.id });
  res.json({ ok: true });
});

// --- Errors ---
// HttpError messages are written for users; anything else (database errors, bugs) is logged and
// answered with a generic 500, so internals never reach the browser.
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  console.error(`${req.method} ${req.originalUrl} failed:`, err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

async function start() {
  secretBox.assertKey(); // fail at startup, not at the first provider search
  await db.waitForDb();
  await auth.ensureBootstrapAdmin();
  await downloads.loadHistory();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GameTorrent web UI listening on http://0.0.0.0:${PORT} (sign-up: ${auth.signupMode()})`);
    // Pre-load box-art indexes for the platforms already in the library so the first Library view has covers.
    try {
      coverArt.warm([...new Set(library.listInstalled(downloads.listFinishedJobs()).map((i) => i.platform))]);
    } catch { /* cosmetic only */ }
  });
}

start().catch((err) => {
  console.error(`Refusing to start: ${err.message}`);
  process.exit(1);
});
