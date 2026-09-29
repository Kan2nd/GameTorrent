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

/** Absolute path of a file inside roms/<platform>/<folder>/, or null if it's missing or escapes that folder. */
function resolveInstalledFile(platform, folder, file) {
  if (!platform || !folder || !file) return null;
  const base = path.resolve(pipeline.ROMS_DIR, String(platform), String(folder));
  const target = path.resolve(base, String(file));
  if (!target.startsWith(base + path.sep)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  return target;
}

function prettify(folder) {
  return folder.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** finishedJobs: completed download records, used only to recover a nicer title than the folder name. */
function listInstalled(finishedJobs) {
  const titles = new Map();
  for (const job of finishedJobs) {
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
