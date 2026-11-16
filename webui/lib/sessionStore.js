'use strict';

/**
 * express-session store backed by the `sessions` table. Replaces the default in-memory store,
 * which logged everyone out on every restart and couldn't be cleared per user. Each row carries
 * the user's id, so revoking someone's access is one DELETE (lib/auth.js: endSessionsFor), and
 * deleting a user removes their sessions through the foreign key.
 */

const session = require('express-session');
const db = require('../db');

const PRUNE_EVERY_MS = 15 * 60 * 1000;

function expiryOf(sess) {
  const exp = sess && sess.cookie && sess.cookie.expires;
  return exp ? new Date(exp) : new Date(Date.now() + 24 * 60 * 60 * 1000);
}

class PgSessionStore extends session.Store {
  constructor() {
    super();
    this.pruneTimer = setInterval(() => {
      db.query('delete from sessions where expires_at < now()').catch((err) => console.error('session prune failed:', err.message));
    }, PRUNE_EVERY_MS);
    this.pruneTimer.unref();
  }

  get(sid, cb) {
    db.query('select sess from sessions where sid = $1 and expires_at > now()', [sid])
      .then((r) => cb(null, r.rows[0] ? r.rows[0].sess : null))
      .catch((err) => cb(err));
  }

  set(sid, sess, cb) {
    db.query(
      `insert into sessions (sid, user_id, sess, expires_at) values ($1, $2, $3, $4)
       on conflict (sid) do update set user_id = excluded.user_id, sess = excluded.sess, expires_at = excluded.expires_at`,
      [sid, sess.userId || null, sess, expiryOf(sess)],
    ).then(() => cb && cb(null)).catch((err) => cb && cb(err));
  }

  touch(sid, sess, cb) {
    db.query('update sessions set expires_at = $2 where sid = $1', [sid, expiryOf(sess)])
      .then(() => cb && cb(null)).catch((err) => cb && cb(err));
  }

  destroy(sid, cb) {
    db.query('delete from sessions where sid = $1', [sid])
      .then(() => cb && cb(null)).catch((err) => cb && cb(err));
  }
}

module.exports = { PgSessionStore };
