/**
 * In-memory job tracking around pipeline.runJob(), plus a history in the
 * `download_jobs` table so completed/failed jobs survive a server restart
 * (in-progress jobs do not; acceptable for this scale of tool).
 *
 * Each job gets its own EventEmitter passed into pipeline.runJob(); we
 * listen for 'log'/'progress' here and just accumulate them onto the job
 * record, which the API then serves to whichever client is polling.
 */

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');
const pipeline = require('../../poc/pipeline');
const db = require('../db');

const MAX_LOG_LINES = 500;

const jobs = new Map(); // id -> job record, newest first is handled at read time
const emitters = new Map(); // id -> EventEmitter of still-running jobs (used to cancel them)

/** Loads finished jobs from the database into memory. Called once at startup. */
async function loadHistory() {
  const { rows } = await db.query('select record from download_jobs');
  for (const r of rows) jobs.set(r.record.id, r.record);
}

/** Saves one finished job. Never throws: a failed write is logged, the job stays in memory. */
function saveJob(job) {
  db.query(
    `insert into download_jobs (id, status, record, scan_skipped, started_at, finished_at) values ($1, $2, $3, $4, $5, $6)
     on conflict (id) do update set status = excluded.status, record = excluded.record, finished_at = excluded.finished_at`,
    [job.id, job.status, job, !!job.scanSkipped, job.startedAt, job.finishedAt],
  ).catch((err) => console.error(`saving job ${job.id} failed:`, err.message));
}

function forgetJobs(ids) {
  if (!ids.length) return;
  db.query('delete from download_jobs where id = any($1::uuid[])', [ids])
    .catch((err) => console.error('deleting job history failed:', err.message));
}

function toPublicJob(job) {
  // jobData carries the emulator's resolved executable path etc. — internal detail, not needed by the frontend.
  const { jobData, ...pub } = job;
  return pub;
}

function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .map(toPublicJob);
}

function listFinishedJobs() {
  return listJobs().filter((j) => j.status === 'done');
}

/**
 * A game was moved from roms/<oldPlatform>/<folder> to roms/<newPlatform>/<folder> (an admin named the console of an
 * "unknown" download). Updates the finished-job records that point at it so the library keeps the nice title.
 */
function reassignPlatform(oldPlatform, newPlatform, folder, oldDir, newDir) {
  for (const job of jobs.values()) {
    if (job.status !== 'done' || job.platform !== oldPlatform || job.destSubfolder !== folder) continue;
    job.platform = newPlatform;
    if (job.romPath && job.romPath.startsWith(oldDir)) job.romPath = newDir + job.romPath.slice(oldDir.length);
    saveJob(job);
  }
}

function getJob(id) {
  const job = jobs.get(id);
  return job ? toPublicJob(job) : null;
}

/** Magnet URIs of every successfully completed job — used to mark search/discover results "installed" rather than "available". */
function getInstalledMagnets() {
  const set = new Set();
  for (const job of jobs.values()) {
    if (job.status === 'done' && job.jobData && job.jobData.magnetUri) set.add(job.jobData.magnetUri);
  }
  return set;
}

/**
 * Any job (still running, or already finished successfully) already fetching this exact
 * magnet — used when approving a request to avoid starting a second, redundant download
 * for a game someone's already getting (or already got). Ignores cancelled/errored jobs,
 * since those aren't "in progress" and should be free to retry.
 */
function findJobByMagnet(magnetUri) {
  if (!magnetUri) return null;
  let best = null;
  for (const job of jobs.values()) {
    if (job.jobData && job.jobData.magnetUri === magnetUri && (isActive(job) || job.status === 'done')) {
      if (!best || new Date(job.startedAt) > new Date(best.startedAt)) best = job;
    }
  }
  return best ? toPublicJob(best) : null;
}

/**
 * input: either { gameId } for a catalog/feed entry, or the direct-mode
 * fields (magnetUri, platform, destSubfolder, romFile, selectPatterns,
 * archiveFormat, sha256, emulatorId).
 * opts: { skipScan, requireScan, noVt, launch } — same meaning as the CLI flags.
 */
function startDownload(input, opts, catalogGames) {
  let jobData;
  if (input.gameId) {
    // catalogGames, when given, is the combined default+feeds list already
    // fetched by the caller (avoids re-fetching every feed just to look up one id).
    jobData = catalogGames
      ? pipeline.buildJobFromGameId(input.gameId, { games: catalogGames })
      : pipeline.buildJobFromGameId(input.gameId);
  } else {
    jobData = pipeline.buildJobFromParams(input);
  }

  const id = crypto.randomUUID();
  const job = {
    id,
    gameId: input.gameId || null,
    title: jobData.title,
    platform: jobData.platform,
    destSubfolder: jobData.destSubfolder,
    status: 'downloading',
    progress: 0,
    logs: [],
    error: null,
    romPath: null,
    canLaunch: !!jobData.emulator,
    // Recorded so a skipped check is visible later (Library shows an UNSCANNED tag), not silent.
    scanSkipped: !!(opts && opts.skipScan),
    vtSkipped: !!(opts && opts.noVt),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    jobData,
  };
  jobs.set(id, job);

  const emitter = new EventEmitter();
  emitters.set(id, emitter);
  emitter.on('log', (msg) => {
    job.logs.push(msg);
    if (job.logs.length > MAX_LOG_LINES) job.logs.shift();
  });
  emitter.on('progress', (p) => { job.progress = p; });

  pipeline.runJob(jobData, opts, emitter)
    .then((result) => {
      emitters.delete(id);
      if (job.cancelled) return;
      job.status = 'done';
      job.romPath = result.romPath;
      job.platform = result.platform;
      job.finishedAt = new Date().toISOString();
      saveJob(job);
    })
    .catch((err) => {
      emitters.delete(id);
      if (job.cancelled) return;
      job.status = 'error';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      saveJob(job);
    });

  return toPublicJob(job);
}

function isActive(job) { return job.status !== 'done' && job.status !== 'error'; }

/** Removes a job's record. A still-running job is cancelled first (best effort: torrent downloads abort, later steps just finish unseen). */
function deleteJob(id) {
  const job = jobs.get(id);
  if (!job) throw new Error('Job not found');
  if (isActive(job)) {
    job.cancelled = true;
    const emitter = emitters.get(id);
    if (emitter) emitter.emit('cancel');
  }
  jobs.delete(id);
  forgetJobs([id]);
}

/** Removes every finished (done/error) job record; running ones are left alone. Returns how many were removed. */
function clearFinished() {
  const removed = [];
  for (const [id, job] of jobs) {
    if (!isActive(job)) { jobs.delete(id); removed.push(id); }
  }
  forgetJobs(removed);
  return removed.length;
}

/** Launches the emulator for an already-completed job. Only meaningful on a machine with a display — see docs/WEBUI.md. */
function launchJob(id) {
  const job = jobs.get(id);
  if (!job) throw new Error('Job not found');
  if (job.status !== 'done') throw new Error(`Job is "${job.status}", not done — nothing to launch yet`);
  if (!job.jobData.emulator) throw new Error('No emulator is configured for this platform');

  const emitter = new EventEmitter();
  emitter.on('log', (msg) => {
    job.logs.push(msg);
    if (job.logs.length > MAX_LOG_LINES) job.logs.shift();
  });

  // Fire-and-forget: the HTTP request returns immediately, the emulator runs in the background.
  pipeline.launchEmulator(job.jobData, job.romPath, true, emitter).catch((err) => {
    job.logs.push(`Launch failed: ${err.message}`);
  });
}

module.exports = { reassignPlatform, loadHistory, listJobs, getJob, startDownload, launchJob, getInstalledMagnets, findJobByMagnet, deleteJob, clearFinished, listFinishedJobs };
