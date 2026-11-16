'use strict';

/**
 * Connection pool to PostgreSQL, as the least-privileged gt_app role (DATABASE_URL). Schema
 * changes never go through here; they run as gt_owner in db/migrate.js (an initContainer in k8s).
 */

const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, idleTimeoutMillis: 30000 });
    // A dropped idle connection must not crash the process; the pool reconnects on next use.
    pool.on('error', (err) => console.error('postgres pool error:', err.message));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

/** Runs fn(client) inside one transaction; rolls back if it throws. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Waits until the database answers (it may still be starting when the app does). */
async function waitForDb({ attempts = 60, delayMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try { await query('select 1'); return; } catch (err) {
      if (i === attempts) throw err;
      console.log(`waiting for database (${i}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { query, tx, waitForDb, close };
