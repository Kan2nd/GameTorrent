'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATS_PATH = path.join(DATA_DIR, 'stats.json');

// Memory cache
let stats = {};

function loadStats() {
  if (!fs.existsSync(STATS_PATH)) {
    stats = {};
    return;
  }
  try {
    stats = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
  } catch (err) {
    console.error('Failed to load stats.json:', err.message);
    stats = {};
  }
}

function saveStats() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2));
}

function incrementDownload(platform, folder) {
  const key = `${platform}/${folder}`;
  if (!stats[key]) {
    stats[key] = { downloadCount: 0 };
  }
  stats[key].downloadCount++;
  saveStats();
}

function getDownloadCount(platform, folder) {
  const key = `${platform}/${folder}`;
  return stats[key] ? stats[key].downloadCount : 0;
}

function removeStats(platform, folder) {
  const key = `${platform}/${folder}`;
  if (stats[key]) {
    delete stats[key];
    saveStats();
  }
}

loadStats();

module.exports = { incrementDownload, getDownloadCount, removeStats };
