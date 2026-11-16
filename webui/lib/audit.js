/**
 * Audit trail for security-relevant actions: who did what, when, from where, and whether it
 * worked. Written to the `audit_log` table, which the app's database role can only INSERT into
 * and SELECT from (no UPDATE/DELETE, see db/migrations/001_init.sql), so even a compromised app
 * can't rewrite history. Every entry is also printed to stdout as one JSON line with
 * "type":"audit", which is how it reaches Loki/Grafana.
 *
 * Never pass secrets in `details`: passwords/tokens must not end up here.
 */

'use strict';

const db = require('../db');

function audit(req, action, details = {}) {
  const actor = (req.session && req.session.username) || null;
  const ip = req.ip || null;
  // details first in the printed line, so a detail can never overwrite who/when/what.
  console.log(JSON.stringify({ type: 'audit', ...details, time: new Date().toISOString(), user: actor, ip, action }));
  db.query('insert into audit_log (actor, ip, action, details) values ($1, $2, $3, $4)', [actor, ip, action, details])
    .catch((err) => console.error('audit log write failed:', err.message)); // never takes the app down; stdout copy above still exists
}

module.exports = { audit };
