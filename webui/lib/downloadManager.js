/**
 * In-memory job tracking around pipeline.runJob(), plus a JSON-file history
 * so completed/failed jobs survive a server restart (in-progress jobs do
 * not — acceptable for this scale of tool; see README for the tradeoff).
 *
 * Each job gets its own EventEmitter passed into pipeline.runJob(); we
 * listen for 'log'/'progress' here and just accumulate them onto the job
 * record, which the API then serves to whichever client is polling.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const pipeline = require('../../poc/pipeline');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_PATH = path.join(DATA_DIR, 'downloads.json');
const MAX_LOG_LINES = 500;

const jobs = new Map(); // id -> job record, newest first is handled at read time
const emitters = new Map(); // id -> EventEmitter of still-running jobs (used to cancel them)

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    for (const job of saved) jobs.set(job.id, job);
  } catch {
    // corrupt/missing history file — start fresh rather than crash the server
  }
}

function persistHistory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const finished = [...jobs.values()].filter((j) => j.status === 'done' || j.status === 'error');
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(finished, null, 2));
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
      persistHistory();
    })
    .catch((err) => {
      emitters.delete(id);
      if (job.cancelled) return;
      job.status = 'error';
      job.error = err.message;
      job.finishedAt = new Date().toISOString();
      persistHistory();
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
  persistHistory();
}

/** Removes every finished (done/error) job record; running ones are left alone. Returns how many were removed. */
function clearFinished() {
  let removed = 0;
  for (const [id, job] of jobs) {
    if (!isActive(job)) { jobs.delete(id); removed++; }
  }
  persistHistory();
  return removed;
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

loadHistory();

module.exports = { listJobs, getJob, startDownload, launchJob, getInstalledMagnets, deleteJob, clearFinished, listFinishedJobs };
