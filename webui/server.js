#!/usr/bin/env node
/**
 * GameTorrent web UI. Thin HTTP layer over poc/pipeline.js — see
 * docs/WEBUI.md for setup (required env vars) and lib/*.js for the
 * actual logic (auth, feeds, download tracking).
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');

const pipeline = require('../poc/pipeline');
const { authenticateUser, requireAuth, requireAdmin } = require('./lib/auth');
const feeds = require('./lib/feeds');
const downloads = require('./lib/downloadManager');
const providers = require('./lib/providers');
const library = require('./lib/library');
const coverArt = require('./lib/coverArt');
const stats = require('./lib/stats');
const { downloadRateLimiter } = require('./lib/rateLimit');
const fs = require('fs');

if (!process.env.WEBUI_USER || !process.env.WEBUI_PASSWORD) {
  console.error(
    'Refusing to start: WEBUI_USER and WEBUI_PASSWORD must both be set.\n' +
    'This app can trigger downloads and (where a display is available) launch\n' +
    'emulators, and is meant to be reachable on your LAN — see docs/WEBUI.md.'
  );
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set — using a random one for this run; everyone will be logged out on restart.');
}

const app = express();
app.set('trust proxy', 'loopback, linklocal, uniquelocal');
app.use(express.json());
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 },
}));

// --- Auth ---

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = authenticateUser(username, password);
  if (user) {
    req.session.authenticated = true;
    req.session.role = user.role;
    res.json({ ok: true, role: user.role });
  } else {
    res.status(401).json({ error: 'Invalid username or password' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ 
    authenticated: !!(req.session && req.session.authenticated),
    role: req.session ? req.session.role : null
  });
});

// --- Static assets (no sensitive data in these — safe to serve pre-auth) ---
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.redirect('/login.html');
  }
});

// --- API (everything below requires a logged-in session) ---
app.use('/api', requireAuth);

app.get('/api/games', async (req, res) => {
  try {
    const { games, warnings } = await feeds.getCombinedCatalog();
    res.json({ games, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/emulators', (req, res) => {
  res.json(pipeline.loadEmulators());
});

app.get('/api/feeds', (req, res) => {
  res.json(feeds.loadFeeds());
});

app.post('/api/feeds', async (req, res) => {
  try {
    const feed = await feeds.addFeed(req.body.url);
    res.json(feed);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/feeds/:id', (req, res) => {
  feeds.removeFeed(req.params.id);
  res.json({ ok: true });
});

app.get('/api/providers', (req, res) => {
  res.json(providers.listProviders());
});

app.post('/api/providers', (req, res) => {
  try {
    const provider = providers.addProvider(req.body || {});
    res.json(provider);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/providers/:id', (req, res) => {
  providers.removeProvider(req.params.id);
  res.json({ ok: true });
});

app.get('/api/search', async (req, res) => {
  try {
    const { providerId, q } = req.query;
    if (providerId) {
      const results = await providers.searchProvider(providerId, q);
      res.json({ results, warnings: [] });
    } else {
      // No provider chosen — search every configured provider ("All providers").
      const { results, warnings } = await providers.searchAllProviders(q);
      res.json({ results, warnings });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/discover', async (req, res) => {
  try {
    const installed = downloads.getInstalledMagnets();
    const sections = await providers.discoverAllProviders(installed);
    res.json(sections);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/downloads', (req, res) => {
  res.json(downloads.listJobs());
});

app.get('/api/installed', async (req, res) => {
  try {
    const installed = library.listInstalled(downloads.listFinishedJobs());
    await Promise.all(installed.map(async (item) => { 
      item.coverImage = await providers.lookupCover(item.title, item.platform);
      item.downloadCount = stats.getDownloadCount(item.platform, item.folder);
    }));
    res.json(installed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Streams one installed file to the browser as a download (the user's own copy of the ROM).
app.get('/api/installed/file', downloadRateLimiter, (req, res) => {
  const target = library.resolveInstalledFile(req.query.platform, req.query.folder, req.query.file);
  if (!target) return res.status(404).json({ error: 'File not found' });
  
  stats.incrementDownload(req.query.platform, req.query.folder);
  res.download(target, path.basename(target));
});

// Admin-only route to delete an installed game completely from disk
app.delete('/api/installed/:platform/:folder', requireAdmin, (req, res) => {
  try {
    const platform = String(req.params.platform);
    const folder = String(req.params.folder);
    if (platform.includes('/') || platform.includes('\\') || platform === '.' || platform === '..') {
      return res.status(400).json({ error: 'Invalid platform' });
    }
    if (folder.includes('/') || folder.includes('\\') || folder === '.' || folder === '..') {
      return res.status(400).json({ error: 'Invalid folder' });
    }
    
    const targetDir = path.resolve(pipeline.ROMS_DIR, platform, folder);
    if (!targetDir.startsWith(pipeline.ROMS_DIR + path.sep)) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      stats.removeStats(platform, folder);
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Game not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Clears every finished job's log entry (running jobs are untouched).
app.delete('/api/downloads', (req, res) => {
  res.json({ removed: downloads.clearFinished() });
});

// Deletes one job's log entry; a still-running job is cancelled first. Never touches downloaded files.
app.delete('/api/downloads/:id', (req, res) => {
  try {
    downloads.deleteJob(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/api/downloads/:id', (req, res) => {
  const job = downloads.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.post('/api/downloads', async (req, res) => {
  try {
    const { gameId, title, magnetUri, directUrl, platform, destSubfolder, romFile, selectPatterns, excludeTypes, archiveFormat, sha256, emulatorId, skipScan, requireScan, noVt, launch } = req.body || {};
    const opts = { skipScan: !!skipScan, requireScan: !!requireScan, noVt: !!noVt, launch: !!launch };

    let catalogGames = null;
    if (gameId) {
      const combined = await feeds.getCombinedCatalog();
      catalogGames = combined.games;
    }

    const job = downloads.startDownload(
      gameId ? { gameId } : { title, magnetUri, directUrl, platform, destSubfolder, romFile, selectPatterns, excludeTypes, archiveFormat, sha256, emulatorId },
      opts,
      catalogGames
    );
    res.json(job);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/downloads/:id/launch', (req, res) => {
  try {
    downloads.launchJob(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`GameTorrent web UI listening on http://0.0.0.0:${PORT}`);
  // Pre-load box-art indexes for the platforms already in the library so the first Library view has covers.
  try {
    coverArt.warm([...new Set(library.listInstalled(downloads.listFinishedJobs()).map((i) => i.platform))]);
  } catch { /* cosmetic only */ }
});
