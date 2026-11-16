'use strict';

/**
 * Accounts, stored in PostgreSQL (`users`, `sessions`). See docs/WEBUI.md "Accounts".
 *
 * - Every request re-reads the user (refreshSessionUser) and uses their CURRENT role and status,
 *   so disabling, demoting or deleting someone takes effect on their very next click.
 * - Any change to a user's role, status or password deletes their sessions (endSessionsFor).
 * - The last active admin can't be demoted, disabled or deleted. That check runs inside a
 *   transaction holding a lock on every admin row, so two admins acting at the same moment
 *   can't both get past it.
 * - Sign-up (SIGNUP_MODE): "approval" (default) makes a pending account an admin must approve;
 *   "open" makes an active one; "off" disables sign-up. Sign-ups are always role "user".
 */

const db = require('../db');
const passwords = require('./passwords');
const { badRequest, forbidden, notFound, conflict } = require('./errors');

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000; // re-login at least weekly, however active

function signupMode() {
  const m = (process.env.SIGNUP_MODE || 'approval').toLowerCase();
  return ['open', 'approval', 'off'].includes(m) ? m : 'approval';
}

function assertUsername(username) {
  const u = String(username || '').trim();
  if (!USERNAME_RE.test(u)) throw badRequest('Username must be 3-32 characters: letters, numbers, "_", "." or "-"');
  return u;
}

function publicUser(row) {
  return {
    id: Number(row.id),
    username: row.username,
    role: row.role,
    status: row.status,
    mustChangePassword: row.must_change_password,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

/** First start on an empty database (and no JSON to import): create the WEBUI_USER admin. */
async function ensureBootstrapAdmin() {
  const { rows } = await db.query('select count(*)::int as n from users');
  if (rows[0].n > 0) return false;
  const username = process.env.WEBUI_USER;
  const password = process.env.WEBUI_PASSWORD;
  if (!username || !password) return false;
  await db.query(
    "insert into users (username, password_hash, role, status) values ($1, $2, 'admin', 'active') on conflict do nothing",
    [assertUsername(username), await passwords.hash(password)],
  );
  console.log(`created the first admin account "${username}" from WEBUI_USER`);
  return true;
}

/**
 * Checks a login. Returns { user } on success, else { reason }: 'invalid' for a wrong
 * username or password (indistinguishable, same timing), 'pending' / 'disabled' only once the
 * password has been proven correct (so those states can't be probed without the password).
 */
async function authenticate(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 1024) {
    return { reason: 'invalid' };
  }
  const { rows } = await db.query('select * from users where lower(username) = lower($1)', [username.trim()]);
  const row = rows[0];
  if (!row) { await passwords.dummyVerify(password); return { reason: 'invalid' }; }
  if (!(await passwords.verify(password, row.password_hash))) return { reason: 'invalid' };
  if (row.status !== 'active') return { reason: row.status };
  if (passwords.needsRehash(row.password_hash)) {
    await db.query('update users set password_hash = $2 where id = $1', [row.id, await passwords.hash(password)]);
  }
  await db.query('update users set last_login_at = now() where id = $1', [row.id]);
  return { user: publicUser(row) };
}

/**
 * Loads the session's user fresh from the database and syncs role/username into the session.
 * Returns the user, or null (and clears the login) if they're gone, not active, or the session
 * is past its absolute lifetime.
 */
async function refreshSessionUser(req) {
  const s = req.session;
  if (!s || !s.authenticated || !s.userId) return null;
  let row = null;
  if (s.loginAt && Date.now() - s.loginAt <= SESSION_ABSOLUTE_MS) {
    const { rows } = await db.query('select * from users where id = $1', [s.userId]);
    row = rows[0] && rows[0].status === 'active' ? rows[0] : null;
  }
  if (!row) {
    s.authenticated = false;
    s.userId = null;
    s.role = null;
    s.username = null;
    return null;
  }
  s.role = row.role;
  s.username = row.username;
  s.mustChangePassword = row.must_change_password;
  return publicUser(row);
}

// Paths a user who must change their password may still use.
const MUST_CHANGE_ALLOWED = new Set(['/api/session', '/api/logout', '/api/account/password']);

function requireAuth(req, res, next) {
  refreshSessionUser(req).then((user) => {
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    req.user = user;
    if (user.mustChangePassword && !MUST_CHANGE_ALLOWED.has(req.originalUrl.split('?')[0])) {
      return res.status(403).json({ error: 'You need to set a new password first', mustChangePassword: true });
    }
    next();
  }).catch(next);
}

function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admin privileges required' });
}

/** Deletes every session of a user, optionally keeping one (the caller's own). */
async function endSessionsFor(userId, exceptSid = null, client = db) {
  await client.query('delete from sessions where user_id = $1 and ($2::text is null or sid <> $2)', [userId, exceptSid]);
}

async function listUsers() {
  const { rows } = await db.query(`
    select u.*, coalesce(p.n, 0)::int as pending_requests
    from users u
    left join (select user_id, count(*) as n from game_requests where status = 'pending' group by user_id) p on p.user_id = u.id
    order by u.status = 'pending' desc, lower(u.username)`);
  return rows.map((r) => ({ ...publicUser(r), pendingRequests: r.pending_requests }));
}

async function getUser(id) {
  const { rows } = await db.query('select * from users where id = $1', [id]);
  return rows[0] ? publicUser(rows[0]) : null;
}

async function insertUser({ username, password, role, status, mustChangePassword, createdBy }) {
  const name = assertUsername(username);
  passwords.assertAcceptable(password);
  const hashValue = await passwords.hash(password);
  try {
    const { rows } = await db.query(
      `insert into users (username, password_hash, role, status, must_change_password, created_by)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [name, hashValue, role === 'admin' ? 'admin' : 'user', status, !!mustChangePassword, createdBy || null],
    );
    return publicUser(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw conflict('That username is already taken');
    throw err;
  }
}

/** Admin creates an account. The person must set their own password at first login by default. */
function createUser({ username, password, role, mustChangePassword = true }, actor) {
  return insertUser({ username, password, role, status: 'active', mustChangePassword, createdBy: actor && actor.id });
}

/** Self sign-up. Always a standard user; pending until an admin approves unless SIGNUP_MODE=open. */
async function signup({ username, password }) {
  const mode = signupMode();
  if (mode === 'off') throw forbidden('Sign-up is turned off on this server. Ask the admin for an account');
  return insertUser({ username, password, role: 'user', status: mode === 'open' ? 'active' : 'pending', mustChangePassword: false });
}

/**
 * Locks every admin row, always in id order. Called FIRST in any transaction that might remove an
 * admin. Taking the locks in one fixed order is what prevents a deadlock when two admins demote
 * each other at the same moment (found by the race test in cicd/tests/api-selftest.js: locking the
 * target row first made each transaction wait for the other's).
 */
async function lockAdmins(client) {
  await client.query("select id from users where role = 'admin' order by id for update");
}

/** Throws if the change would leave the server with no active admin. Call inside tx(), after lockAdmins. */
async function assertKeepsAnAdmin(client, targetId, change) {
  const { rows } = await client.query("select id from users where role = 'admin' and status = 'active'");
  const targetIsActiveAdmin = rows.some((r) => Number(r.id) === Number(targetId));
  if (targetIsActiveAdmin && rows.length <= 1) throw badRequest(`Can't ${change} the last active admin`);
}

/** Admin changes role and/or status (approving a sign-up = status 'active'). */
async function updateUser(id, { role, status }, actor) {
  if (Number(id) === Number(actor.id)) throw badRequest("You can't change your own role or status");
  if (role !== undefined && !['admin', 'user'].includes(role)) throw badRequest('role must be "admin" or "user"');
  if (status !== undefined && !['active', 'disabled'].includes(status)) throw badRequest('status must be "active" or "disabled"');
  return db.tx(async (client) => {
    await lockAdmins(client);
    const { rows } = await client.query('select * from users where id = $1 for update', [id]);
    const target = rows[0];
    if (!target) throw notFound('User not found');
    if ((role === 'user' && target.role === 'admin') || (status === 'disabled' && target.role === 'admin')) {
      await assertKeepsAnAdmin(client, id, role === 'user' ? 'demote' : 'disable');
    }
    const approving = target.status === 'pending' && status === 'active';
    const { rows: updated } = await client.query(
      `update users set role = coalesce($2, role), status = coalesce($3, status),
              approved_by = case when $4::boolean then $5::bigint else approved_by end
       where id = $1 returning *`,
      [id, role || null, status || null, approving, actor.id],
    );
    await endSessionsFor(id, null, client);
    return { user: publicUser(updated[0]), approved: approving };
  });
}

/** Admin sets a temporary password; the user must replace it at next login. */
async function resetPassword(id, newPassword, actor) {
  if (Number(id) === Number(actor.id)) throw badRequest('Use "Change my password" for your own account');
  passwords.assertAcceptable(newPassword);
  const hashValue = await passwords.hash(newPassword);
  return db.tx(async (client) => {
    const { rowCount } = await client.query(
      'update users set password_hash = $2, must_change_password = true, password_changed_at = now() where id = $1',
      [id, hashValue],
    );
    if (!rowCount) throw notFound('User not found');
    await endSessionsFor(id, null, client);
  });
}

/** A user changes their own password (current one required). Logs out their other sessions. */
async function changeOwnPassword(userId, currentPassword, newPassword, keepSid) {
  const { rows } = await db.query('select * from users where id = $1', [userId]);
  const row = rows[0];
  if (!row) throw notFound('User not found');
  if (!(await passwords.verify(String(currentPassword || ''), row.password_hash))) throw badRequest('Current password is wrong');
  passwords.assertAcceptable(newPassword);
  if (newPassword === currentPassword) throw badRequest('The new password must be different');
  const hashValue = await passwords.hash(newPassword);
  await db.tx(async (client) => {
    await client.query(
      'update users set password_hash = $2, must_change_password = false, password_changed_at = now() where id = $1',
      [userId, hashValue],
    );
    await endSessionsFor(userId, keepSid, client);
  });
}

async function deleteUser(id, actor) {
  if (Number(id) === Number(actor.id)) throw badRequest("Can't delete the account you're logged in as");
  return db.tx(async (client) => {
    await lockAdmins(client);
    const { rows } = await client.query('select * from users where id = $1 for update', [id]);
    if (!rows[0]) throw notFound('User not found');
    if (rows[0].role === 'admin') await assertKeepsAnAdmin(client, id, 'delete');
    await client.query('delete from users where id = $1', [id]); // sessions go with it (FK cascade)
    return publicUser(rows[0]);
  });
}

module.exports = {
  signupMode, ensureBootstrapAdmin, authenticate, refreshSessionUser, requireAuth, requireAdmin,
  endSessionsFor, listUsers, getUser, createUser, signup, updateUser, resetPassword, changeOwnPassword, deleteUser,
};
