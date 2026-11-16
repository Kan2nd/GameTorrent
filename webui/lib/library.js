/**
 * "Installed" view of the Library tab, built from what's actually on disk
 * under roms/<platform>/<folder>/ — not from download history — so clearing
 * old download logs never makes an installed game disappear.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const pipeline = require('../../poc/pipeline');

/** Every file under dir as { path (relative, forward slashes), size }. */
function listFiles(dir, base = dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(listFiles(full, base));
    else out.push({ path: path.relative(base, full).split(path.sep).join('/'), size: fs.statSync(full).size });
  }
  return out;
}

/** The files worth offering as "the ROM": ones with the platform's ROM extension, or all files if none match. */
function romCandidates(platform, files) {
  const exts = pipeline.ROM_EXTENSIONS[platform] || [];
  const matches = files.filter((f) => exts.includes(path.extname(f.path).toLowerCase()));
  return matches.length ? matches : files;
}

function isSafeName(s) {
  try { pipeline.assertSafeName(s, 'name'); return true; } catch { return false; }
}

/**
 * Absolute path of a file inside roms/<platform>/<folder>/, or null if it's missing or escapes
 * that folder.
 *
 * All three checks matter. Before 2026-11-05 only `file` was checked against the folder, so a
 * request with platform=".." and folder="webui" made the "folder" /app/webui itself, and any
 * logged-in user could download data/users.json or data/providers.json from there.
 * 1. platform and folder must each be one plain name (no separators, no "." or "..").
 * 2. The folder must sit strictly inside ROMS_DIR, and the file strictly inside the folder.
 * 3. Same check again after resolving symlinks (realpath), so a link inside a game folder can't
 *    point back out of it.
 */
function resolveInstalledFile(platform, folder, file) {
  if (!platform || !folder || !file) return null;
  if (!isSafeName(platform) || !isSafeName(folder)) return null;
  const roms = path.resolve(pipeline.ROMS_DIR);
  const base = path.resolve(roms, String(platform), String(folder));
  const target = path.resolve(base, String(file));
  if (!base.startsWith(roms + path.sep) || !target.startsWith(base + path.sep)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  let realRoms, realBase, realTarget;
  try {
    realRoms = fs.realpathSync(roms);
    realBase = fs.realpathSync(base);
    realTarget = fs.realpathSync(target);
  } catch { return null; }
  if (!realBase.startsWith(realRoms + path.sep) || !realTarget.startsWith(realBase + path.sep)) return null;
  return realTarget;
}

function prettify(folder) {
  return folder.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** finishedJobs: completed download records, used only to recover a nicer title than the folder name. */
function listInstalled(finishedJobs) {
  const titles = new Map();
  const unscanned = new Set();
  for (const job of finishedJobs) {
    if (job.scanSkipped && job.destSubfolder) unscanned.add(`${job.platform}/${job.destSubfolder}`);
    if (job.destSubfolder && job.title && job.title !== job.destSubfolder) {
      titles.set(`${job.platform}/${job.destSubfolder}`, job.title);
    }
  }

  const installed = [];
  if (!fs.existsSync(pipeline.ROMS_DIR)) return installed;

  for (const platformEntry of fs.readdirSync(pipeline.ROMS_DIR, { withFileTypes: true })) {
    if (!platformEntry.isDirectory()) continue;
    const platformDir = path.join(pipeline.ROMS_DIR, platformEntry.name);
    for (const gameEntry of fs.readdirSync(platformDir, { withFileTypes: true })) {
      if (!gameEntry.isDirectory()) continue;
      const gameDir = path.join(platformDir, gameEntry.name);
      const files = listFiles(gameDir);
      const size = files.reduce((n, f) => n + f.size, 0);
      if (size === 0) continue;
      installed.push({
        platform: platformEntry.name,
        folder: gameEntry.name,
        title: titles.get(`${platformEntry.name}/${gameEntry.name}`) || prettify(gameEntry.name),
        scanSkipped: unscanned.has(`${platformEntry.name}/${gameEntry.name}`),
        size,
        romFiles: romCandidates(platformEntry.name, files),
        path: `roms/${platformEntry.name}/${gameEntry.name}`,
        modifiedAt: fs.statSync(gameDir).mtime.toISOString(),
      });
    }
  }
  return installed.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

module.exports = { listInstalled, resolveInstalledFile };
