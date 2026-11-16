'use strict';

const ACTIVE_STATUSES = new Set(['downloading', 'scanning', 'extracting', 'verifying']);
const PLATFORM_LABELS = {
  nes: 'NES', snes: 'SNES', gb: 'Game Boy', gbc: 'Game Boy Color',
  gba: 'Game Boy Advance', nds: 'Nintendo DS', '3ds': 'Nintendo 3DS',
  n64: 'Nintendo 64', gamecube: 'GameCube', genesis: 'Sega Genesis',
  saturn: 'Sega Saturn', dreamcast: 'Sega Dreamcast', psx: 'PlayStation',
  psp: 'PSP', dos: 'MS-DOS', pc: 'PC', switch: 'Nintendo Switch',
};
// Consoles the detector can name but GameTorrent can't sort or launch (kept out of PLATFORM_LABELS
// on purpose: that map also fills the "Add custom download" platform picker).
const EXTRA_PLATFORM_LABELS = {
  wii: 'Wii', wiiu: 'Wii U', xbox: 'Xbox', xbox360: 'Xbox 360',
  ps2: 'PlayStation 2', ps3: 'PlayStation 3', ps4: 'PlayStation 4', psvita: 'PS Vita',
  sms: 'Master System', gamegear: 'Game Gear', pcengine: 'PC Engine', atari2600: 'Atari 2600', atari7800: 'Atari 7800',
  lynx: 'Atari Lynx', wonderswan: 'WonderSwan', neogeopocket: 'Neo Geo Pocket',
  // A download whose console couldn't be worked out: it is kept, and an admin can name the console later.
  unknown: 'Unknown console',
};
/** Consoles an admin can assign to an "unknown" install: everything we can name, sorted by label. */
function assignablePlatforms() {
  const all = { ...PLATFORM_LABELS, ...EXTRA_PLATFORM_LABELS };
  delete all.unknown;
  return Object.entries(all).sort((a, b) => a[1].localeCompare(b[1]));
}
function platformLabel(p) { return PLATFORM_LABELS[p] || EXTRA_PLATFORM_LABELS[p] || p; }

/**
 * Badges for a search result's console, worked out server-side BEFORE anything downloads
 * (lib/platformDetect.js). Each badge is {text, cls, title}. "Guess" badges carry a "?".
 */
function detectTags(d) {
  if (!d) return [];
  const tags = [];
  if (d.platform) {
    const guess = d.confidence === 'guess';
    const unsupported = d.supported === false;
    tags.push({
      text: platformLabel(d.platform) + (guess ? '?' : '') + (unsupported ? ' · unsupported' : ''),
      cls: unsupported ? 'tag-warn' : guess ? 'tag-platform tag-guess' : 'tag-platform',
      title: (guess ? 'Best guess: ' : 'Detected: ') + d.why + '.' +
        (unsupported ? " GameTorrent can't sort or launch this console yet, so it won't offer to download it." : ''),
    });
  } else if (d.candidates && d.candidates.length > 1) {
    tags.push({ text: d.candidates.map(platformLabel).join(' / ') + '?', cls: 'tag-warn', title: 'The title mentions several consoles - it may be a multi-platform pack.' });
  } else {
    tags.push({ text: 'Unknown', cls: 'tag-unknown', title: "Couldn't tell the console from the title or the indexer's category. GameTorrent works it out from the downloaded files instead." });
  }
  if (d.hack) tags.push({ text: 'Hack', cls: 'tag-hack', title: 'A fan-made ROM hack. It needs the original game underneath, and some hacks ship only as patch files.' });
  if (d.patchLikely) tags.push({ text: 'Patch?', cls: 'tag-warn', title: 'Looks like a patch file (.ips/.bps/.ups), not a playable ROM: it must be applied to a clean copy of the original game first.' });
  return tags;
}
function tagHtml(t) {
  const o = typeof t === 'string' ? { text: t } : t;
  return `<span class="tag${o.cls ? ' ' + o.cls : ''}"${o.title ? ` title="${escapeHtml(o.title)}"` : ''}>${escapeHtml(o.text)}</span>`;
}
/** Grouping key for the filter chips: the detected console, or 'unknown'. */
function detectKey(d) { return d && d.platform ? d.platform : 'unknown'; }
function isUnsupported(d) { return !!(d && d.platform && d.supported === false); }

/** Cover image with a cartridge-sprite fallback for when it's missing or fails to load. */
function coverPlaceholderHtml() {
  return `<div class="game-card-cover-placeholder">${Sprites.html('cart')}<span>No cover art</span></div>`;
}
function coverFallback(img) {
  const holder = document.createElement('template');
  holder.innerHTML = coverPlaceholderHtml();
  img.replaceWith(holder.content.firstElementChild);
}
// Broken cover images fall back to a placeholder. Done with one capture-phase listener (image
// 'error' events don't bubble) instead of inline onerror="" attributes, which the Content-Security-
// Policy forbids as inline script.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains('game-card-cover')) return;
  if (img.dataset.fallback) img.outerHTML = img.dataset.fallback;
  else coverFallback(img);
}, true);

function coverHtml(src, title) {
  if (!src) return coverPlaceholderHtml();
  return `<img class="game-card-cover" src="${escapeHtml(src)}" alt="${escapeHtml(title)} cover art" loading="lazy">`;
}

/** Small pixel icon + label for a job status, e.g. a tick for done, a cross for error. */
function statusPillHtml(status) {
  const icon = status === 'done' ? 'check' : status === 'error' ? 'cross' : 'bolt';
  return `<span class="status-pill status-${status}">${Sprites.html(icon)}${status}</span>`;
}

let pollTimer = null;
let libraryHasCatalog = false;
let installedItems = [];
let catalogGames = [];
// What the Library toolbar is set to. `text` is matched typo-tolerantly (public/fuzzy.js).
const libFilter = { text: '', platform: '', sort: 'recent' };
let libraryHasInstalled = false;
let sessionRole = null; // Store user role from session
let sessionUsername = null;
const logToggled = new Map(); // job id -> whether the user opened/closed its log (survives the 1.5s re-render)
let pendingDownload = null; // { gameId } or the direct-mode fields, set when the modal is open

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = '/login.html';
    throw new Error('Not authenticated');
  }
  const data = await res.json().catch(() => ({}));
  // An admin reset this user's password: nothing else works until they choose their own.
  if (res.status === 403 && data.mustChangePassword) openAccountModal(true);
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// --- Tabs ---

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'library') loadInstalled().catch(console.error);
    if (btn.dataset.tab === 'requests') loadMyRequests().catch(console.error);
    if (btn.dataset.tab === 'admin') {
      loadAdminRequests().catch(console.error);
      loadAdminUsers().catch(console.error);
    }
  });
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// --- Library ---

async function loadLibrary() {
  const { games, warnings } = await api('/api/games');
  const warnBanner = document.getElementById('feedWarnings');
  if (warnings.length) {
    warnBanner.textContent = warnings.join(' — ');
    warnBanner.hidden = false;
  } else {
    warnBanner.hidden = true;
  }

  catalogGames = games;
  libraryHasCatalog = games.length > 0;
  refreshLibraryEmptyState();
  renderLibrary();
}

function renderCatalog() {
  const games = visibleLibrary(catalogGames);
  const grid = document.getElementById('gameGrid');
  grid.innerHTML = '';
  document.getElementById('catalogHeading').hidden = !games.length;
  for (const game of games) {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.innerHTML = `
      ${coverHtml(game.coverImage, game.title)}
      <h3>${escapeHtml(game.title)}</h3>
      <div class="tags">
        <span class="tag">${escapeHtml(platformLabel(game.platform))}</span>
        <span class="tag">${escapeHtml(game.license || '')}</span>
        <span class="tag">${escapeHtml(game.feedSource)}</span>
      </div>
      <p class="desc">${escapeHtml(game.description || '')}</p>
      <button data-game-id="${escapeHtml(game.id)}">Download</button>
    `;
    const hasEmulator = !!(game.launch && game.launch.emulatorId);
    card.querySelector('button').addEventListener('click', () => openDownloadModal({ gameId: game.id }, game.title, hasEmulator));
    grid.appendChild(card);
  }
}

// --- Library filter / search / sort (client-side, over both the Installed and Catalog grids) ---

/** Text a library entry is searched by: its title, its console's name and its folder. */
function libraryText(x) { return `${x.title} ${platformLabel(x.platform)} ${x.platform} ${x.folder || ''}`; }

function textMatches(items) {
  const q = libFilter.text.trim();
  return q ? Fuzzy.rank(items, q, libraryText) : items;
}

/** The entries to show: typed text (best match first), then the console chip, then the chosen sort. */
function visibleLibrary(items) {
  let out = textMatches(items);
  if (libFilter.platform) out = out.filter((x) => x.platform === libFilter.platform);
  if (libFilter.text.trim() && libFilter.sort === 'recent') return out;   // with a search typed, best match is the default order
  const by = {
    recent: (a, b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0),
    name: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
    size: (a, b) => (b.size || 0) - (a.size || 0),
    downloads: (a, b) => (b.downloadCount || 0) - (a.downloadCount || 0),
  }[libFilter.sort];
  // The catalog has no "modified" date: for "newest" it simply keeps its feed order.
  return libFilter.sort === 'recent' && !out.some((x) => x.modifiedAt) ? out : out.slice().sort(by);
}

function renderLibraryToolbar() {
  const toolbar = document.getElementById('libraryToolbar');
  const total = installedItems.length + catalogGames.length;
  toolbar.hidden = total === 0;
  if (!total) return;

  // Chips count what the typed text matches, so the numbers always agree with what a click will show.
  const counts = new Map();
  for (const x of textMatches([...installedItems, ...catalogGames])) counts.set(x.platform, (counts.get(x.platform) || 0) + 1);
  if (libFilter.platform && !counts.has(libFilter.platform)) counts.set(libFilter.platform, 0);
  const chips = document.getElementById('libraryChips');
  chips.innerHTML = '';
  const matching = [...counts.values()].reduce((a, b) => a + b, 0);
  const entries = [['', 'All', matching], ...[...counts.entries()]
    .sort((a, b) => (a[0] === 'unknown') - (b[0] === 'unknown') || b[1] - a[1] || platformLabel(a[0]).localeCompare(platformLabel(b[0])))
    .map(([key, n]) => [key, platformLabel(key), n])];
  chips.hidden = counts.size < 2 && !libFilter.platform;
  for (const [key, label, n] of entries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (key === libFilter.platform ? ' active' : '');
    chip.textContent = `${label} (${n})`;
    chip.addEventListener('click', () => { libFilter.platform = key; renderLibrary(); });
    chips.appendChild(chip);
  }

  const shown = visibleLibrary(installedItems).length + visibleLibrary(catalogGames).length;
  document.getElementById('libraryCount').textContent = shown === total ? `${total} games` : `${shown} of ${total} games`;
  document.getElementById('libraryNoMatch').hidden = shown > 0;
  const typed = libFilter.text.trim();
  document.getElementById('libraryNoMatchText').textContent = typed
    ? `Nothing matches "${typed}"${libFilter.platform ? ` on ${platformLabel(libFilter.platform)}` : ''}. Check the spelling, or try fewer words.`
    : `Nothing here for ${platformLabel(libFilter.platform)}.`;
}

function renderLibrary() {
  renderLibraryToolbar();
  renderInstalled();
  renderCatalog();
}

document.getElementById('libraryFilter').addEventListener('input', (e) => { libFilter.text = e.target.value; renderLibrary(); });
document.getElementById('librarySort').addEventListener('change', (e) => { libFilter.sort = e.target.value; renderLibrary(); });
document.getElementById('libraryClear').addEventListener('click', () => {
  libFilter.text = ''; libFilter.platform = ''; libFilter.sort = 'recent';
  document.getElementById('libraryFilter').value = '';
  document.getElementById('librarySort').value = 'recent';
  renderLibrary();
});

function refreshLibraryEmptyState() {
  document.getElementById('libraryEmpty').hidden = libraryHasCatalog || libraryHasInstalled;
}

/** Generated tile for games with no cover art: colour comes from the platform, big letters from the title. */
function placeholderArtHtml(title, platform) {
  let hue = 0;
  for (const ch of String(platform)) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const initials = String(title).replace(/\b(rom|gba|nds|the|of)\b/gi, ' ').split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 3).map((w) => w[0].toUpperCase()).join('') || '?';
  return `<div class="art-tile" style="background:linear-gradient(135deg,hsl(${hue},55%,34%),hsl(${(hue + 45) % 360},60%,16%))"><span class="art-initials">${escapeHtml(initials)}</span><span class="art-platform">${escapeHtml(platformLabel(platform))}</span></div>`;
}

function installedCoverHtml(item) {
  if (!item.coverImage) return placeholderArtHtml(item.title, item.platform);
  const fallback = placeholderArtHtml(item.title, item.platform).replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  return `<img class="game-card-cover" src="${escapeHtml(item.coverImage)}" alt="${escapeHtml(item.title)} cover art" loading="lazy" data-fallback="${fallback}">`;
}

async function loadInstalled() {
  installedItems = await api('/api/installed');
  libraryHasInstalled = installedItems.length > 0;
  refreshLibraryEmptyState();
  renderLibrary();
}

function renderInstalled() {
  const installed = visibleLibrary(installedItems);
  const section = document.getElementById('installedSection');
  const grid = document.getElementById('installedGrid');
  section.hidden = !installed.length;
  grid.innerHTML = '';
  for (const item of installed) {
    const card = document.createElement('div');
    card.className = 'game-card installed';
    card.innerHTML = `
      ${installedCoverHtml(item)}
      <h3>${escapeHtml(item.title)}</h3>
      <div class="tags">
        <span class="tag${item.platform === 'unknown' ? ' tag-unknown' : ''}">${escapeHtml(platformLabel(item.platform))}</span>
        <span class="tag">${escapeHtml(formatBytes(item.size))}</span>
        <span class="tag tag-stats">${item.downloadCount || 0} downloads</span>
        ${item.scanSkipped ? '<span class="tag tag-warn" title="An admin skipped the ClamAV scan when this was downloaded">UNSCANNED</span>' : ''}
      </div>
      <p class="desc"><code>${escapeHtml(item.path)}</code></p>
    `;
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    for (const f of item.romFiles.slice(0, 4)) {
      const a = document.createElement('a');
      a.className = 'btn-link';
      a.href = `/api/installed/file?platform=${encodeURIComponent(item.platform)}&folder=${encodeURIComponent(item.folder)}&file=${encodeURIComponent(f.path)}`;
      a.download = '';
      a.textContent = item.romFiles.length > 1 ? `Download ${f.path.split('/').pop()}` : 'Download ROM';
      a.title = `${f.path} (${formatBytes(f.size)})`;
      actions.appendChild(a);
    }
    
    if (sessionRole === 'admin' && item.platform === 'unknown') {
      const pick = document.createElement('select');
      pick.className = 'platform-pick';
      pick.title = 'Name the console this game is for';
      pick.innerHTML = '<option value="">Set console...</option>' +
        assignablePlatforms().map(([k, label]) => `<option value="${escapeHtml(k)}">${escapeHtml(label)}</option>`).join('');
      pick.addEventListener('change', async () => {
        if (!pick.value) return;
        pick.disabled = true;
        try {
          await api(`/api/installed/${encodeURIComponent(item.platform)}/${encodeURIComponent(item.folder)}/platform`, {
            method: 'POST', body: JSON.stringify({ platform: pick.value }),
          });
          await loadInstalled();
        } catch (err) {
          pick.disabled = false;
          pick.value = '';
          alert(`Failed to set the console: ${err.message}`);
        }
      });
      actions.appendChild(pick);
    }

    if (sessionRole === 'admin') {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'danger-btn';
      deleteBtn.textContent = 'Delete';
      deleteBtn.title = 'Permanently delete this game from the server';
      deleteBtn.addEventListener('click', async () => {
        const confirmed = await showConfirmDialog(
          'Delete Game',
          `Are you sure you want to completely delete ${item.title} from the server? This cannot be undone.`
        );
        if (!confirmed) return;
        try {
          await api(`/api/installed/${encodeURIComponent(item.platform)}/${encodeURIComponent(item.folder)}`, { method: 'DELETE' });
          await loadInstalled();
        } catch (err) {
          alert(`Failed to delete: ${err.message}`);
        }
      });
      actions.appendChild(deleteBtn);
    }
    
    card.appendChild(actions);
    grid.appendChild(card);
  }
}

/**
 * Lets a table turn into stacked "cards" on a phone (CSS .stack-on-phone): each cell gets its column's heading as
 * data-label, which the CSS prints in front of the value. Wide tables used to scroll sideways with the buttons off screen.
 */
function labelCells(table) {
  const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
  table.classList.add('stack-on-phone');
  table.querySelectorAll('tbody tr').forEach((tr) => {
    [...tr.children].forEach((td, i) => td.setAttribute('data-label', heads[i] || ''));
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// --- Download modal ---

function openDownloadModal(input, title, hasEmulator) {
  pendingDownload = input;
  document.getElementById('modalTitle').textContent = `Start download — ${title}`;
  document.getElementById('optSkipScan').checked = false;
  document.getElementById('optNoVt').checked = false;
  document.getElementById('optLaunch').checked = false;
  document.getElementById('optLaunchRow').hidden = !hasEmulator;
  document.getElementById('downloadModal').hidden = false;
}

document.getElementById('modalCancel').addEventListener('click', () => {
  document.getElementById('downloadModal').hidden = true;
  pendingDownload = null;
});

document.getElementById('modalConfirm').addEventListener('click', async () => {
  if (!pendingDownload) return;
  const body = {
    ...pendingDownload,
    skipScan: document.getElementById('optSkipScan').checked,
    noVt: document.getElementById('optNoVt').checked,
    launch: document.getElementById('optLaunch').checked,
  };
  document.getElementById('downloadModal').hidden = true;
  pendingDownload = null;

  try {
    const result = await api('/api/downloads', { method: 'POST', body: JSON.stringify(body) });
    await handleDownloadResponse(result);
  } catch (err) {
    alert(`Could not start download: ${err.message}`);
  }
});

// --- Custom download modal ---

for (const [value, label] of Object.entries({ auto: 'Auto-detect (recommended)', ...PLATFORM_LABELS })) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  document.getElementById('customPlatform').appendChild(opt);
}

function openCustomDownloadModal(prefill) {
  document.getElementById('customDownloadForm').reset();
  document.getElementById('customDownloadError').hidden = true;
  document.getElementById('customUrlRow').hidden = true;
  document.getElementById('customMagnetRow').hidden = false;

  if (prefill && prefill.magnetUri) {
    document.getElementById('customSourceType').value = 'magnet';
    document.getElementById('customMagnetUri').value = prefill.magnetUri;
    if (prefill.destSubfolder) document.getElementById('customDest').value = prefill.destSubfolder;
  }

  document.getElementById('customDownloadModal').hidden = false;
}

document.getElementById('customDownloadBtn').addEventListener('click', () => openCustomDownloadModal());

document.getElementById('customDownloadCancel').addEventListener('click', () => {
  document.getElementById('customDownloadModal').hidden = true;
});

document.getElementById('customSourceType').addEventListener('change', (e) => {
  const isUrl = e.target.value === 'directUrl';
  document.getElementById('customUrlRow').hidden = !isUrl;
  document.getElementById('customMagnetRow').hidden = isUrl;
});

document.getElementById('customDownloadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('customDownloadError');
  errorEl.hidden = true;

  const isUrl = document.getElementById('customSourceType').value === 'directUrl';
  const selectValue = document.getElementById('customSelect').value.trim();

  const body = {
    magnetUri: isUrl ? undefined : document.getElementById('customMagnetUri').value.trim(),
    directUrl: isUrl ? document.getElementById('customDirectUrl').value.trim() : undefined,
    platform: document.getElementById('customPlatform').value,
    destSubfolder: document.getElementById('customDest').value.trim(),
    romFile: document.getElementById('customRomFile').value.trim(),
    selectPatterns: selectValue ? [selectValue] : [],
    archiveFormat: document.getElementById('customArchive').value,
    skipScan: document.getElementById('customSkipScan').checked,
    noVt: document.getElementById('customNoVt').checked,
  };

  try {
    const result = await api('/api/downloads', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('customDownloadModal').hidden = true;
    await handleDownloadResponse(result);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

// --- Downloads ---

function updateDownloadsBadge(jobs) {
  const btn = document.querySelector('.tab-btn[data-tab="downloads"]');
  const count = jobs.filter((j) => ACTIVE_STATUSES.has(j.status)).length;
  const existing = btn.querySelector('.tab-badge');
  if (existing) existing.remove();
  if (count) {
    const badge = document.createElement('span');
    badge.className = 'tab-badge';
    badge.textContent = count;
    btn.appendChild(badge);
  }
}

async function loadDownloads() {
  const jobs = await api('/api/downloads');
  const list = document.getElementById('downloadList');
  list.innerHTML = '';

  if (!jobs.length) {
    list.innerHTML = `<div class="empty-state">${Sprites.html('invader', 'sprite-xl')}<p>No downloads yet — search for a game in the Search tab, or add one from the Library.</p></div>`;
    updateDownloadsBadge(jobs);
    return;
  }

  updateDownloadsBadge(jobs);
  for (const job of jobs) {
    const item = document.createElement('div');
    item.className = 'download-item';
    const pct = Math.round((job.progress || 0) * 100);
    const active = ACTIVE_STATUSES.has(job.status);
    item.classList.add(active ? 'is-active' : job.status === 'done' ? 'is-done' : 'is-error');
    const logOpen = (logToggled.has(job.id) ? logToggled.get(job.id) : active || job.status === 'error') ? ' open' : '';
    const lastLog = job.logs.length ? job.logs[job.logs.length - 1] : 'Starting...';
    item.innerHTML = `
      <div class="row">
        <strong>${escapeHtml(job.title)}</strong>
        <span class="actions">
          ${statusPillHtml(job.status)}
          <button class="danger-btn admin-only" data-delete="${job.id}">${active ? 'Cancel' : 'Delete'}</button>
        </span>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${job.status === 'done' ? 100 : pct}%"></div></div>
      <div class="meta"><span>${escapeHtml(platformLabel(job.platform))}</span><span>${active ? pct + '%' : ''}</span></div>
      ${job.error ? `<p class="error">${escapeHtml(job.error)}</p>` : ''}
      <details${logOpen}><summary>Log (${job.logs.length}) — ${escapeHtml(lastLog)}</summary><div class="log-box">${job.logs.map(escapeHtml).join('\n')}</div></details>
      ${job.status === 'done' && job.canLaunch ? `<button class="admin-only" data-launch="${job.id}">Launch</button>` : ''}
    `;
    const details = item.querySelector('details');
    details.querySelector('summary').addEventListener('click', () => logToggled.set(job.id, !details.open));
    item.querySelector('[data-delete]').addEventListener('click', async () => {
      try {
        await api(`/api/downloads/${job.id}`, { method: 'DELETE' });
        await loadDownloads();
      } catch (err) { alert(`Could not remove: ${err.message}`); }
    });
    const launchBtn = item.querySelector('[data-launch]');
    if (launchBtn) {
      launchBtn.addEventListener('click', async () => {
        try { await api(`/api/downloads/${job.id}/launch`, { method: 'POST' }); }
        catch (err) { alert(`Could not launch: ${err.message}`); }
      });
    }
    list.appendChild(item);
  }
}

document.getElementById('clearFinishedBtn').addEventListener('click', async () => {
  try {
    await api('/api/downloads', { method: 'DELETE' });
    await loadDownloads();
  } catch (err) { alert(`Could not clear: ${err.message}`); }
});

function schedulePoll() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    await loadDownloads();
    const jobs = await api('/api/downloads');
    if (!jobs.some((j) => ACTIVE_STATUSES.has(j.status))) {
      clearInterval(pollTimer);
      pollTimer = null;
      loadInstalled().catch(console.error);
    }
  }, 1500);
}

// --- File-type filter (which torrent files to skip) ---

const SKIP_PREF_KEY = 'gametorrent.skipTypes';

function initFileFilter() {
  const boxes = document.querySelectorAll('#fileFilterBar [data-skip]');
  let saved = ['video', 'audio']; // default: skip video/audio extras; untick everything to keep all
  try {
    const raw = localStorage.getItem(SKIP_PREF_KEY);
    if (raw !== null) saved = JSON.parse(raw);
  } catch { /* storage unavailable — fall back to the default */ }
  boxes.forEach((box) => {
    box.checked = saved.includes(box.dataset.skip);
    box.addEventListener('change', () => {
      try { localStorage.setItem(SKIP_PREF_KEY, JSON.stringify(selectedSkipTypes())); } catch { /* ignore */ }
    });
  });
}

function selectedSkipTypes() {
  return [...document.querySelectorAll('#fileFilterBar [data-skip]:checked')].map((b) => b.dataset.skip);
}

/**
 * Shared tail end of every "start a download" action: an admin's click starts a
 * real job (switch to Downloads), while a standard user's click only ever
 * produced a pending request (switch to My Requests instead).
 */
async function handleDownloadResponse(result) {
  if (result && result.requested) {
    document.querySelector('.tab-btn[data-tab="requests"]').click();
    await loadMyRequests();
    return;
  }
  document.querySelector('.tab-btn[data-tab="downloads"]').click();
  await loadDownloads();
  schedulePoll();
}

/** One-click download from a search/browse result: platform and archive format are auto-detected, no form. */
async function quickDownload(result) {
  try {
    const response = await api('/api/downloads', {
      method: 'POST',
      body: JSON.stringify({
        magnetUri: result.magnetUri,
        title: result.title,
        destSubfolder: slugify(result.title),
        platform: 'auto',
        archiveFormat: 'auto',
        excludeTypes: selectedSkipTypes(),
      }),
    });
    await handleDownloadResponse(response);
  } catch (err) {
    alert(`Could not start download: ${err.message}`);
  }
}

// --- Search providers ---

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Turns a search result title into a reasonable default folder name. */
function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'download';
}

async function loadProviders() {
  const list = await api('/api/providers');
  const ul = document.getElementById('providerList');
  ul.innerHTML = '';
  for (const provider of list) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(provider.name)}<span class="muted admin-only"> — ${escapeHtml(provider.baseUrl)}</span></span>`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'ghost-btn admin-only';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      await api(`/api/providers/${provider.id}`, { method: 'DELETE' });
      await loadProviders();
    });
    const editBtn = document.createElement('button');
    editBtn.className = 'ghost-btn admin-only';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openProviderEditor(li, provider));
    li.appendChild(editBtn);
    li.appendChild(removeBtn);
    ul.appendChild(li);
  }

  const select = document.getElementById('searchProviderSelect');
  select.innerHTML = '<option value="">All providers</option>';
  for (const provider of list) {
    const opt = document.createElement('option');
    opt.value = provider.id;
    opt.textContent = provider.name;
    select.appendChild(opt);
  }
}

/** Turns one provider row into a small form: change the name or the URL (e.g. to http://jackett:9117) without re-typing the key. */
function openProviderEditor(li, provider) {
  li.innerHTML = '';
  const form = document.createElement('form');
  form.className = 'inline-form provider-edit';
  form.innerHTML = `
    <input type="text" name="name" required maxlength="100" aria-label="Name" value="${escapeHtml(provider.name)}">
    <input type="url" name="baseUrl" required aria-label="Base URL" value="${escapeHtml(provider.baseUrl)}">
    <input type="password" name="apiKey" autocomplete="off" aria-label="API key" placeholder="API key: leave empty to keep the saved one">
    <button type="submit">Save</button>
    <button type="button" class="ghost-btn" data-cancel>Cancel</button>
    <span class="error" hidden></span>`;
  form.querySelector('[data-cancel]').addEventListener('click', () => loadProviders());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = form.querySelector('.error');
    err.hidden = true;
    const body = { name: form.name.value.trim(), baseUrl: form.baseUrl.value.trim() };
    if (form.apiKey.value.trim()) body.apiKey = form.apiKey.value.trim();
    try {
      await api(`/api/providers/${provider.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      await loadProviders();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  li.appendChild(form);
  form.name.focus();
}

document.getElementById('addProviderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('providerError');
  errorEl.hidden = true;
  const body = {
    name: document.getElementById('providerName').value.trim(),
    baseUrl: document.getElementById('providerBaseUrl').value.trim(),
    apiKey: document.getElementById('providerApiKey').value.trim(),
  };
  try {
    await api('/api/providers', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('addProviderForm').reset();
    await loadProviders();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

// --- "Looking for": the kinds of file/ROM to search for together with the game name ---
const KINDS_PREF_KEY = 'gametorrent.kinds';
let searchKindList = [];            // [{ id, label, group }] from the server
const pickedKinds = new Set();

async function initKindChips() {
  try { searchKindList = await api('/api/search/kinds'); } catch { searchKindList = []; }
  try {
    const saved = JSON.parse(localStorage.getItem(KINDS_PREF_KEY) || '[]');
    for (const id of saved) if (searchKindList.some((k) => k.id === id)) pickedKinds.add(id);
  } catch { /* storage unavailable: start with nothing picked */ }
  renderKindChips();
}

function renderKindChips() {
  const box = document.getElementById('kindChips');
  box.innerHTML = '';
  const groups = [['console', 'Consoles'], ['file', 'File types']];
  for (const [group, title] of groups) {
    const row = document.createElement('div');
    row.className = 'kind-row';
    row.innerHTML = `<span class="muted kind-title">${title}</span>`;
    for (const kind of searchKindList.filter((k) => k.group === group)) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (pickedKinds.has(kind.id) ? ' active' : '');
      chip.textContent = kind.label;
      chip.setAttribute('aria-pressed', pickedKinds.has(kind.id) ? 'true' : 'false');
      chip.addEventListener('click', () => toggleKind(kind.id));
      row.appendChild(chip);
    }
    box.appendChild(row);
  }
  if (pickedKinds.size) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ghost-btn';
    clear.textContent = `Clear (${pickedKinds.size})`;
    clear.addEventListener('click', () => { pickedKinds.clear(); kindsChanged(); });
    box.appendChild(clear);
  }
}

function toggleKind(id) {
  if (pickedKinds.has(id)) pickedKinds.delete(id); else pickedKinds.add(id);
  kindsChanged();
}

function kindsChanged() {
  try { localStorage.setItem(KINDS_PREF_KEY, JSON.stringify([...pickedKinds])); } catch { /* ignore */ }
  renderKindChips();
  // A search is on screen: run it again with the new picks instead of making the user press Search.
  if (!document.getElementById('searchBackBtn').hidden && document.getElementById('searchQuery').value.trim()) {
    document.getElementById('searchForm').requestSubmit();
  }
}

let activePlatformFilter = null;

/** "All / GBA (3) / NDS (2) / Unknown (1)" chips above the results, so a mixed search can be narrowed to one console. */
function renderPlatformChips(results) {
  const box = document.getElementById('platformChips');
  activePlatformFilter = null;
  const counts = new Map();
  for (const r of results) counts.set(detectKey(r.detect), (counts.get(detectKey(r.detect)) || 0) + 1);
  box.innerHTML = '';
  if (counts.size < 2) { box.hidden = true; applyPlatformFilter(); return; }

  const entries = [['', 'All', results.length], ...[...counts.entries()]
    .sort((a, b) => (a[0] === 'unknown') - (b[0] === 'unknown') || b[1] - a[1])
    .map(([key, n]) => [key, key === 'unknown' ? 'Unknown' : platformLabel(key), n])];
  for (const [key, label, n] of entries) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (key === '' ? ' active' : '');
    chip.textContent = `${label} (${n})`;
    chip.addEventListener('click', () => {
      activePlatformFilter = key || null;
      box.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
      applyPlatformFilter();
    });
    box.appendChild(chip);
  }
  box.hidden = false;
  applyPlatformFilter();
}

function applyPlatformFilter() {
  document.querySelectorAll('#searchResultsTable tbody tr').forEach((tr) => {
    tr.hidden = !!activePlatformFilter && tr.dataset.platform !== activePlatformFilter;
  });
}

function showBrowseView() {
  document.getElementById('platformChips').hidden = true;
  document.getElementById('searchResultsTable').hidden = true;
  document.getElementById('searchEmpty').hidden = true;
  document.getElementById('searchWarnings').hidden = true;
  document.getElementById('searchError').hidden = true;
  document.getElementById('searchBackBtn').hidden = true;
  document.getElementById('discoverSections').hidden = false;
  document.getElementById('discoverEmpty').hidden = true;
}

document.getElementById('searchBackBtn').addEventListener('click', () => {
  document.getElementById('searchQuery').value = '';
  showBrowseView();
});

document.getElementById('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('searchError');
  const emptyEl = document.getElementById('searchEmpty');
  const warnEl = document.getElementById('searchWarnings');
  const table = document.getElementById('searchResultsTable');
  errorEl.hidden = true;
  emptyEl.hidden = true;
  warnEl.hidden = true;
  table.hidden = true;
  document.getElementById('discoverSections').hidden = true;
  document.getElementById('discoverEmpty').hidden = true;
  document.getElementById('searchBackBtn').hidden = false;

  const providerId = document.getElementById('searchProviderSelect').value;
  const q = document.getElementById('searchQuery').value.trim();

  let data;
  try {
    let qs = providerId
      ? `providerId=${encodeURIComponent(providerId)}&q=${encodeURIComponent(q)}`
      : `q=${encodeURIComponent(q)}`;
    if (pickedKinds.size) qs += `&kinds=${encodeURIComponent([...pickedKinds].join(','))}`;
    data = await api(`/api/search?${qs}`);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    return;
  }

  const { results, warnings } = data;
  if (warnings && warnings.length) {
    warnEl.textContent = `Some providers didn't respond: ${warnings.join(' — ')}`;
    warnEl.hidden = false;
  }

  if (data.kinds && data.kinds.length) {
    const names = data.kinds.map((id) => (searchKindList.find((k) => k.id === id) || { label: id }).label).join(' / ');
    const hidden = data.hiddenByKinds ? ` ${data.hiddenByKinds} other result${data.hiddenByKinds === 1 ? ' was' : 's were'} hidden: clear the "Looking for" picks to see them.` : '';
    const note = `Showing only: ${names}.${hidden}`;
    warnEl.textContent = warnEl.hidden ? note : `${warnEl.textContent} ${note}`;
    warnEl.hidden = false;
  }
  if (data.expandedFrom && data.expandedFrom.length && results.length) {
    const note = `Few exact matches for "${q}", so close spellings and related titles were searched too.`;
    warnEl.textContent = warnEl.hidden ? note : `${warnEl.textContent} ${note}`;
    warnEl.hidden = false;
  }
  if (!results.length) {
    emptyEl.textContent = data.kinds && data.kinds.length
      ? `No results for "${q}" that match your "Looking for" picks${data.hiddenByKinds ? ` (${data.hiddenByKinds} other results were hidden)` : ''}. Try fewer picks, or none.`
      : `No results for "${q}", even allowing for typos. Try fewer words, or just the main word of the title.`;
    emptyEl.hidden = false;
    return;
  }

  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';
  // Most-seeded first (dead torrents sink to the bottom); usable magnets before "no magnet" rows.
  // Close matches before loose ones (the server scores every title against what was typed), then most seeders.
  const close = (r) => (r.match == null || r.match >= 0.55 ? 1 : 0);
  results.sort((a, b) => (!!b.magnetUri - !!a.magnetUri) || (close(b) - close(a)) || ((b.seeders || 0) - (a.seeders || 0)));
  for (const r of results) {
    const tr = document.createElement('tr');
    const canUse = !!r.magnetUri;
    const dead = !r.seeders;
    if (dead) tr.className = 'likely-dead';
    tr.innerHTML = `
      <td>${escapeHtml(r.title)}</td>
      <td class="platform-cell">${detectTags(r.detect).map(tagHtml).join(' ')}</td>
      <td>${escapeHtml(r.indexer || '')}${!providerId ? ` <span class="muted">(${escapeHtml(r.providerName)})</span>` : ''}</td>
      <td>${formatBytes(r.size)}</td>
      <td>${r.seeders ?? '?'}${dead ? ' <span class="tag tag-warn" title="Nobody is sharing this torrent, so it will most likely never start.">likely dead</span>' : ''}</td>
      <td>${isUnsupported(r.detect) ? '<span class="muted" title="GameTorrent cannot sort or launch this console yet.">Unsupported</span>' : canUse ? `<button type="button"${dead ? ' class="ghost-btn"' : ''}>${dead ? 'Download anyway' : 'Download'}</button>` : '<span class="muted" title="This indexer only provides a .torrent file link, which GameTorrent can\'t fetch yet — magnet links only.">No magnet</span>'}</td>
    `;
    if (canUse && !isUnsupported(r.detect)) {
      tr.querySelector('button').addEventListener('click', () => quickDownload(r));
    }
    tr.dataset.platform = detectKey(r.detect);
    tbody.appendChild(tr);
  }
  table.hidden = false;
  labelCells(table);
  renderPlatformChips(results);
});

// --- Discover (provider "sections" — browse without downloading) ---

const DISCOVER_INITIAL_SHOWN = 5;

function gameCardHtml(title, coverImage, tags, statusHtml, showUseButton) {
  return `
    ${coverHtml(coverImage, title)}
    <h3>${escapeHtml(title)}</h3>
    <div class="tags">${tags.map(tagHtml).join('')}</div>
    ${statusHtml}
    ${showUseButton ? '<button type="button" data-use>Download</button>' : ''}
  `;
}

async function loadDiscover() {
  const container = document.getElementById('discoverSections');
  const emptyEl = document.getElementById('discoverEmpty');
  let sections;
  try {
    sections = await api('/api/discover');
  } catch (err) {
    container.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    return;
  }

  container.innerHTML = '';
  if (!sections.length) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  for (const section of sections) {
    const wrap = document.createElement('div');
    wrap.className = 'discover-section';

    const heading = document.createElement('h4');
    heading.textContent = section.providerName;
    wrap.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'game-grid';
    wrap.appendChild(grid);

    // Live torrents first so the initially visible cards are ones that can actually start.
    section.results.sort((a, b) => (b.seeders || 0) - (a.seeders || 0));
    section.results.forEach((r, i) => {
      const card = document.createElement('div');
      card.className = 'game-card';
      card.hidden = i >= DISCOVER_INITIAL_SHOWN;
      const status = r.installed
        ? `<span class="status-pill status-done">${Sprites.html('check')}Installed</span>`
        : '<span class="status-pill status-available">Available</span>';
      const dead = !r.seeders;
      const tags = [...detectTags(r.detect), formatBytes(r.size), dead ? 'likely dead — 0 seeders' : `${r.seeders} seeders`];
      card.innerHTML = gameCardHtml(r.title, r.coverImage, tags, status, !r.installed && !isUnsupported(r.detect));
      if (dead) card.classList.add('likely-dead');
      const useBtn = card.querySelector('[data-use]');
      if (useBtn) {
        if (dead) { useBtn.textContent = 'Download anyway'; useBtn.classList.add('ghost-btn'); }
        useBtn.addEventListener('click', () => quickDownload(r));
      }
      grid.appendChild(card);
    });

    if (section.results.length > DISCOVER_INITIAL_SHOWN) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'ghost-btn see-more-btn';
      moreBtn.type = 'button';
      moreBtn.textContent = `See more (${section.results.length - DISCOVER_INITIAL_SHOWN})`;
      moreBtn.addEventListener('click', () => {
        grid.querySelectorAll('.game-card[hidden]').forEach((c) => { c.hidden = false; });
        moreBtn.remove();
      });
      wrap.appendChild(moreBtn);
    }

    container.appendChild(wrap);
  }
}

// --- Feeds ---

async function loadFeeds() {
  const feedList = await api('/api/feeds');
  const ul = document.getElementById('feedList');
  ul.innerHTML = '';
  for (const feed of feedList) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(feed.name)} — <span class="muted">${escapeHtml(feed.url)}</span></span>`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'ghost-btn admin-only';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      await api(`/api/feeds/${feed.id}`, { method: 'DELETE' });
      await loadFeeds();
      await loadLibrary();
    });
    li.appendChild(removeBtn);
    ul.appendChild(li);
  }
}

document.getElementById('addFeedForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('feedError');
  errorEl.hidden = true;
  const url = document.getElementById('feedUrl').value;
  try {
    await api('/api/feeds', { method: 'POST', body: JSON.stringify({ url }) });
    document.getElementById('feedUrl').value = '';
    await loadFeeds();
    await loadLibrary();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

// --- Emulators ---

async function loadEmulators() {
  const emulators = await api('/api/emulators');
  const tbody = document.querySelector('#emulatorTable tbody');
  tbody.innerHTML = '';
  for (const [platform, cfg] of Object.entries(emulators)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(platformLabel(platform))}</td>
      <td>${escapeHtml(cfg.name)}</td>
      <td><code>${escapeHtml(cfg.executable)}</code></td>
      <td><code>${escapeHtml((cfg.argsTemplate || []).join(' '))}</code></td>
    `;
    tbody.appendChild(tr);
  }
  labelCells(document.getElementById('emulatorTable'));
}

// --- Modals: Escape or a click on the backdrop closes them ---

for (const id of ['downloadModal', 'customDownloadModal']) {
  const modal = document.getElementById(id);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) modal.hidden = true; });
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.getElementById('downloadModal').hidden = true;
  document.getElementById('customDownloadModal').hidden = true;
});

// --- Game requests (standard user side) ---

function requestStatusPillHtml(status) {
  const icon = status === 'approved' ? 'check' : status === 'rejected' ? 'cross' : 'bolt';
  const cls = status === 'approved' ? 'status-done' : status === 'rejected' ? 'status-error' : 'status-pending';
  return `<span class="status-pill ${cls}">${Sprites.html(icon)}${escapeHtml(status)}</span>`;
}

/** Adds/removes the small count badge on a tab button, same convention as the Downloads tab. */
function setTabBadge(tab, count) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
  if (!btn) return;
  const existing = btn.querySelector('.tab-badge');
  if (existing) existing.remove();
  if (count) {
    const badge = document.createElement('span');
    badge.className = 'tab-badge';
    badge.textContent = count;
    btn.appendChild(badge);
  }
}

async function loadMyRequests() {
  const list = await api('/api/requests/mine');
  const box = document.getElementById('requestsList');
  document.getElementById('requestsEmpty').hidden = !!list.length;
  box.innerHTML = '';
  setTabBadge('requests', list.filter((r) => r.status === 'pending').length);

  for (const r of list) {
    const item = document.createElement('div');
    item.className = `download-item is-${r.status === 'approved' ? 'done' : r.status === 'rejected' ? 'error' : 'active'}`;
    item.innerHTML = `
      <div class="row">
        <strong>${escapeHtml(r.title)}</strong>
        ${requestStatusPillHtml(r.status)}
      </div>
      <div class="meta">
        <span>${escapeHtml(platformLabel(r.platform || 'auto'))}</span>
        <span>Requested ${new Date(r.requestedAt).toLocaleString()}</span>
      </div>
      ${r.status === 'rejected' && r.reason ? `<p class="error">Reason: ${escapeHtml(r.reason)}</p>` : ''}
      ${r.status === 'approved' ? `<p class="muted">Approved — check the Downloads tab for progress.</p>` : ''}
    `;
    if (r.status === 'pending') {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'ghost-btn';
      cancelBtn.textContent = 'Cancel request';
      cancelBtn.addEventListener('click', async () => {
        try {
          await api(`/api/requests/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
          await loadMyRequests();
        } catch (err) {
          alert(`Could not cancel request: ${err.message}`);
        }
      });
      item.appendChild(cancelBtn);
    }
    box.appendChild(item);
  }
}

// --- Admin: pending requests + user management ---

/** What an admin is actually approving: catalog entry, torrent, or which host a direct URL points at. */
function requestSourceLabel(input) {
  if (input.gameId) return `catalog entry "${input.gameId}"`;
  if (input.magnetUri) return 'magnet (torrent)';
  if (input.directUrl) {
    try { return `direct download from ${new URL(input.directUrl).host}`; } catch { return 'direct download (unparseable URL)'; }
  }
  return 'unknown';
}

async function loadAdminRequests() {
  const all = await api('/api/requests');
  const pending = all.filter((r) => r.status === 'pending');
  const box = document.getElementById('adminRequestsList');
  document.getElementById('adminRequestsEmpty').hidden = !!pending.length;
  box.innerHTML = '';
  setTabBadge('admin', pending.length);

  for (const r of pending) {
    const item = document.createElement('div');
    item.className = 'download-item is-active';
    item.innerHTML = `
      <div class="row">
        <strong>${escapeHtml(r.title)}</strong>
        ${requestStatusPillHtml(r.status)}
      </div>
      <div class="meta">
        <span>${escapeHtml(platformLabel(r.platform || 'auto'))}</span>
        <span>Requested by ${escapeHtml(r.username)} — ${new Date(r.requestedAt).toLocaleString()}</span>
      </div>
      <div class="meta">
        <span>Source: ${escapeHtml(requestSourceLabel(r.input))}</span>
        <span>Folder: ${escapeHtml(r.input.destSubfolder || r.input.gameId || '?')}</span>
      </div>
    `;
    // Scan options are decided here by the admin, never carried on the request itself.
    const opts = document.createElement('div');
    opts.className = 'meta';
    opts.innerHTML = `
      <label><input type="checkbox" data-opt="skipScan"> Skip ClamAV scan</label>
      <label><input type="checkbox" data-opt="noVt"> Skip VirusTotal lookup</label>
    `;
    item.appendChild(opts);

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const approveBtn = document.createElement('button');
    approveBtn.textContent = 'Approve';
    approveBtn.addEventListener('click', async () => {
      const chosen = {};
      opts.querySelectorAll('input[data-opt]').forEach((cb) => { chosen[cb.dataset.opt] = cb.checked; });
      try {
        const result = await api(`/api/requests/${encodeURIComponent(r.id)}/approve`, { method: 'POST', body: JSON.stringify(chosen) });
        if (result.alsoApproved) {
          alert(`Approved — ${result.alsoApproved} other pending request${result.alsoApproved > 1 ? 's' : ''} for the same game ${result.alsoApproved > 1 ? 'were' : 'was'} approved too, sharing this one download.`);
        }
        await loadAdminRequests();
        await loadAdminUsers();
      } catch (err) {
        alert(`Could not approve request: ${err.message}`);
      }
    });

    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'danger-btn';
    rejectBtn.textContent = 'Reject';
    rejectBtn.addEventListener('click', async () => {
      const reason = await showReasonDialog('Reject request', `Reason for rejecting "${r.title}"?`, 'Reject');
      if (reason === null) return; // cancelled
      try {
        await api(`/api/requests/${encodeURIComponent(r.id)}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
        await loadAdminRequests();
        await loadAdminUsers();
      } catch (err) {
        alert(`Could not reject request: ${err.message}`);
      }
    });

    actions.appendChild(approveBtn);
    actions.appendChild(rejectBtn);
    item.appendChild(actions);
    box.appendChild(item);
  }
}

const STATUS_LABELS = { active: 'Active', pending: 'Waiting for approval', disabled: 'Disabled' };

async function loadAdminUsers() {
  const users = await api('/api/users');
  const tbody = document.querySelector('#usersTable tbody');
  tbody.innerHTML = '';

  for (const u of users) {
    const isMe = u.username === sessionUsername;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(u.username)}${isMe ? ' <span class="muted">(you)</span>' : ''}${u.mustChangePassword ? ' <span class="tag tag-warn" title="Has to set a new password at next sign-in">TEMP PW</span>' : ''}</td>
      <td>${escapeHtml(u.role)}</td>
      <td>${u.status === 'active' ? escapeHtml(STATUS_LABELS[u.status]) : `<span class="tag tag-warn">${escapeHtml(STATUS_LABELS[u.status] || u.status)}</span>`}</td>
      <td>${u.pendingRequests || 0}</td>
      <td class="muted">${u.lastLoginAt ? escapeHtml(new Date(u.lastLoginAt).toLocaleString()) : 'never'}</td>
    `;
    const actionCell = document.createElement('td');
    const button = (label, cls, onClick) => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', async () => {
        try { await onClick(); await loadAdminUsers(); } catch (err) { alert(`${label} failed: ${err.message}`); }
      });
      actionCell.appendChild(b);
    };
    const patch = (body) => api(`/api/users/${u.id}`, { method: 'PATCH', body: JSON.stringify(body) });

    if (!isMe) {
      if (u.status === 'pending') {
        button('Approve', '', () => patch({ status: 'active' }));
        button('Reject', 'danger-btn', async () => {
          if (await showConfirmDialog('Reject sign-up', `Delete the sign-up "${u.username}"?`)) await api(`/api/users/${u.id}`, { method: 'DELETE' });
        });
      } else {
        if (u.status === 'active') button('Disable', 'ghost-btn', () => patch({ status: 'disabled' }));
        else button('Enable', 'ghost-btn', () => patch({ status: 'active' }));
        button(u.role === 'admin' ? 'Make standard user' : 'Make admin', 'ghost-btn', () => patch({ role: u.role === 'admin' ? 'user' : 'admin' }));
        button('Reset password', 'ghost-btn', async () => {
          const pw = await showReasonDialog('Reset password', `Temporary password for "${u.username}" (12+ characters). They will have to replace it when they sign in.`, 'Set password', 'password');
          if (pw) await api(`/api/users/${u.id}/password`, { method: 'POST', body: JSON.stringify({ password: pw }) });
        });
        button('Sign out', 'ghost-btn', () => api(`/api/users/${u.id}/logout`, { method: 'POST' }));
        button('Delete', 'danger-btn', async () => {
          if (await showConfirmDialog('Delete user', `Delete the account "${u.username}"? This cannot be undone.`)) await api(`/api/users/${u.id}`, { method: 'DELETE' });
        });
      }
    }
    tr.appendChild(actionCell);
    tbody.appendChild(tr);
  }
  labelCells(document.getElementById('usersTable'));
}

document.getElementById('addUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('addUserError');
  errorEl.hidden = true;
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newUserPassword').value;
  const role = document.getElementById('newUserRole').value;
  const mustChangePassword = document.getElementById('newUserMustChange').checked;

  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ username, password, role, mustChangePassword }) });
    document.getElementById('addUserForm').reset();
    await loadAdminUsers();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

// --- My account (change password, sign out elsewhere) ---

let accountForced = false;

function openAccountModal(forced) {
  accountForced = !!forced;
  document.getElementById('accountForm').reset();
  document.getElementById('accountUsername').textContent = sessionUsername || '';
  document.getElementById('accountForcedText').hidden = !accountForced;
  document.getElementById('accountClose').hidden = accountForced;
  document.getElementById('accountSessions').hidden = accountForced;
  document.getElementById('accountError').hidden = true;
  document.getElementById('accountOk').hidden = true;
  document.getElementById('accountSessionsMsg').hidden = true;
  document.getElementById('accountModal').hidden = false;
  document.getElementById('accountCurrent').focus();
}

function closeAccountModal() {
  if (accountForced) return;   // nothing else works until the password is changed
  document.getElementById('accountModal').hidden = true;
  document.getElementById('accountBtn').focus();
}

// Escape, or a click on the dark area around the box, closes it (not while a password change is forced).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !document.getElementById('accountModal').hidden) closeAccountModal();
});
document.getElementById('accountModal').addEventListener('mousedown', (e) => {
  if (e.target === e.currentTarget) closeAccountModal();
});

document.getElementById('accountBtn').addEventListener('click', () => openAccountModal(false));
document.getElementById('accountClose').addEventListener('click', closeAccountModal);

document.getElementById('accountLogoutEverywhere').addEventListener('click', async () => {
  const msg = document.getElementById('accountSessionsMsg');
  msg.className = 'ok';
  try {
    await api('/api/account/logout-everywhere', { method: 'POST' });
    msg.textContent = 'Done. Every other browser signed in as you has been signed out.';
  } catch (err) {
    msg.className = 'error';
    msg.textContent = err.message;
  }
  msg.hidden = false;
});

document.getElementById('accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('accountError');
  errEl.hidden = true;
  const currentPassword = document.getElementById('accountCurrent').value;
  const newPassword = document.getElementById('accountNew').value;
  if (newPassword !== document.getElementById('accountNew2').value) {
    errEl.textContent = 'The two new passwords are different';
    errEl.hidden = false;
    return;
  }
  try {
    await api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
    document.getElementById('accountForm').reset();
    document.getElementById('accountOk').hidden = false;
    if (accountForced) window.location.reload(); // everything else was blocked until now
  } catch (err) {
    errEl.textContent = err.message;
    errEl.hidden = false;
  }
});

// --- Init ---

function showConfirmDialog(title, text) {
  return new Promise((resolve) => {
    const modal = document.getElementById('confirmModal');
    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalText').textContent = text;
    
    const cancelBtn = document.getElementById('confirmModalCancel');
    const okBtn = document.getElementById('confirmModalOk');
    
    const cleanup = () => {
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      modal.hidden = true;
    };
    
    const onCancel = () => { cleanup(); resolve(false); };
    const onOk = () => { cleanup(); resolve(true); };
    
    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);

    modal.hidden = false;
  });
}

/** Like showConfirmDialog, but with a text field — resolves the typed text, or null if cancelled. */
function showReasonDialog(title, text, okLabel, inputType) {
  return new Promise((resolve) => {
    const modal = document.getElementById('reasonModal');
    document.getElementById('reasonModalTitle').textContent = title;
    document.getElementById('reasonModalText').textContent = text;
    const input = document.getElementById('reasonModalInput');
    input.value = '';
    input.type = inputType || 'text'; // 'password' for the admin's temporary-password prompt

    const cancelBtn = document.getElementById('reasonModalCancel');
    const okBtn = document.getElementById('reasonModalOk');
    okBtn.textContent = okLabel || 'OK';

    const cleanup = () => {
      cancelBtn.removeEventListener('click', onCancel);
      okBtn.removeEventListener('click', onOk);
      input.removeEventListener('keydown', onKeydown);
      modal.hidden = true;
    };
    const onCancel = () => { cleanup(); resolve(null); };
    const onOk = () => { const value = input.value; cleanup(); resolve(value); };
    const onKeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); onOk(); } };

    cancelBtn.addEventListener('click', onCancel);
    okBtn.addEventListener('click', onOk);
    input.addEventListener('keydown', onKeydown);

    modal.hidden = false;
    input.focus();
  });
}

(async function init() {
  try {
    const sessionInfo = await api('/api/session');
    if (!sessionInfo.authenticated) { window.location.href = '/login.html'; return; }
    sessionRole = sessionInfo.role;
    sessionUsername = sessionInfo.username;
    if (sessionInfo.mustChangePassword) { openAccountModal(true); return; }
    document.getElementById('adminTabBtn').hidden = sessionRole !== 'admin';
    // Hides every .admin-only control for standard users (the server enforces this regardless).
    document.body.classList.toggle('is-admin', sessionRole === 'admin');
    // Admins download directly and never file a request, so the tab is pointless for them.
    document.getElementById('requestsTabBtn').hidden = sessionRole === 'admin';

    initFileFilter();
    await initKindChips();
    await loadLibrary();
    await loadInstalled();
    await loadDownloads();
    await loadProviders();
    await loadDiscover();
    await loadFeeds();
    await loadEmulators();
    if (sessionRole === 'admin') {
      await loadAdminRequests();
      await loadAdminUsers();
    } else {
      await loadMyRequests();
    }
    schedulePoll();
  } catch (err) {
    console.error(err);
  }
})();
