/**
 * Game requests: GameTorrent is run by one admin for other people ("provider" model), so a
 * standard user doesn't start a download directly. They file a request, and an admin approves
 * or rejects it. Approving actually starts the download (downloadManager.startDownload); this
 * module only tracks the request record, in the `game_requests` table.
 *
 * Requests belong to a user id, not a username: if an account is deleted and someone later
 * signs up with the same name, they don't inherit the old person's requests.
 */

'use strict';

const crypto = require('crypto');
const db = require('../db');

/**
 * Identifies "the same game" across separate requests (possibly from different users), so
 * approving one can be linked to the others instead of starting a redundant second download.
 */
function dedupeKeyFor(input) {
  if (input.gameId) return `game:${input.gameId}`;
  if (input.magnetUri) return `magnet:${input.magnetUri}`;
  if (input.directUrl) return `url:${input.directUrl}`;
  return `dest:${input.platform || ''}/${input.destSubfolder || ''}`;
}

function toRequest(r) {
  return {
    id: r.id,
    userId: r.user_id === null ? null : Number(r.user_id),
    username: r.requested_by_name,
    input: r.input,
    title: r.title,
    platform: r.platform,
    status: r.status,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by_name,
    reason: r.reason,
    jobId: r.job_id,
  };
}

/** input: validated download fields. Scan/launch options are deliberately not stored. */
async function createRequest(user, input, meta) {
  const title = (meta && meta.title) || input.title || input.gameId || input.destSubfolder || 'Untitled request';
  const platform = (meta && meta.platform) || input.platform || null;
  const { rows } = await db.query(
    `insert into game_requests (id, user_id, requested_by_name, title, platform, input, dedupe_key)
     values ($1, $2, $3, $4, $5, $6, $7) returning *`,
    [crypto.randomUUID(), user.id, user.username, title, platform, input, dedupeKeyFor(input)],
  );
  return toRequest(rows[0]);
}

async function listRequests() {
  const { rows } = await db.query('select * from game_requests order by requested_at desc');
  return rows.map(toRequest);
}

async function listRequestsForUser(userId) {
  const { rows } = await db.query('select * from game_requests where user_id = $1 order by requested_at desc', [userId]);
  return rows.map(toRequest);
}

async function getRequest(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
  const { rows } = await db.query('select * from game_requests where id = $1', [id]);
  return rows[0] ? toRequest(rows[0]) : null;
}

/**
 * Step 1 of approving: atomically marks this request, and every other still-pending request for
 * the same game, approved. `where status = 'pending'` is what makes it safe: if two admins
 * approve at the same moment (or approve two duplicate requests), only the first update matches
 * any rows, so exactly one download starts. Returns the claimed ids; empty = already decided.
 */
async function claimWithSiblings(request, decidedBy) {
  const { rows } = await db.query(
    `update game_requests set status = 'approved', decided_at = now(), decided_by_name = $3
     where status = 'pending' and (id = $1 or dedupe_key = $2) returning id`,
    [request.id, dedupeKeyFor(request.input), decidedBy],
  );
  return rows.map((r) => r.id);
}

/** Step 2: links the claimed requests to the job that was started for them. */
async function linkJob(ids, jobId) {
  await db.query('update game_requests set job_id = $2 where id = any($1::uuid[])', [ids, jobId]);
}

/** If starting the download failed after claiming: put the requests back to pending. */
async function unclaim(ids) {
  await db.query("update game_requests set status = 'pending', decided_at = null, decided_by_name = null where id = any($1::uuid[])", [ids]);
}

async function rejectRequest(id, reason, decidedBy) {
  const { rowCount } = await db.query(
    `update game_requests set status = 'rejected', decided_at = now(), decided_by_name = $3, reason = $2
     where id = $1 and status = 'pending'`,
    [id, reason ? String(reason).slice(0, 500) : null, decidedBy],
  );
  return rowCount > 0;
}

async function deleteRequest(id) {
  const { rowCount } = await db.query('delete from game_requests where id = $1', [id]);
  return rowCount > 0;
}

module.exports = {
  createRequest, listRequests, listRequestsForUser, getRequest,
  claimWithSiblings, linkJob, unclaim, rejectRequest, deleteRequest, dedupeKeyFor,
};
