'use strict';

/** Per-game download counters, in the `game_stats` table (was data/stats.json). */

const db = require('../db');

async function incrementDownload(platform, folder) {
  await db.query(
    `insert into game_stats (platform, folder, download_count) values ($1, $2, 1)
     on conflict (platform, folder) do update set download_count = game_stats.download_count + 1`,
    [String(platform), String(folder)],
  );
}

/** { "platform/folder": count } for every game, in one query. */
async function getAllCounts() {
  const { rows } = await db.query('select platform, folder, download_count from game_stats');
  const out = {};
  for (const r of rows) out[`${r.platform}/${r.folder}`] = r.download_count;
  return out;
}

async function removeStats(platform, folder) {
  await db.query('delete from game_stats where platform = $1 and folder = $2', [String(platform), String(folder)]);
}

/** A game moved to another platform folder: carry its download counter along (merging if the target already has one). */
async function movePlatform(oldPlatform, newPlatform, folder) {
  await db.query(
    `insert into game_stats (platform, folder, download_count)
       select $2, folder, download_count from game_stats where platform = $1 and folder = $3
     on conflict (platform, folder) do update set download_count = game_stats.download_count + excluded.download_count`,
    [String(oldPlatform), String(newPlatform), String(folder)],
  );
  await removeStats(oldPlatform, folder);
}

module.exports = { incrementDownload, getAllCounts, removeStats, movePlatform };
