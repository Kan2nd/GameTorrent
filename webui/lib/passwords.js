'use strict';

/**
 * Password hashing. scrypt with OWASP's recommended parameters (N=2^15, r=8, p=3: ~32 MiB per
 * hash). The parameters are stored inside each hash ('scrypt$N$r$p$salt$hash'), so they can be
 * raised later without breaking existing accounts: verify() reads them back, and needsRehash()
 * says when a hash should be rewritten at the next successful login.
 *
 * Runs on libuv's thread pool (4 threads by default), so at most 4 hashes are in flight at once:
 * ~128 MiB peak, well inside the pod's memory limit, and a login burst can't block the event loop.
 *
 * Legacy format 'salt:hash' (N=16384, r=8, p=1, from users.json) is still verified, then
 * upgraded. Plaintext passwords are NOT accepted any more (the JSON import hashes them).
 */

const crypto = require('crypto');
const { badRequest } = require('./errors');

const PARAMS = { N: 32768, r: 8, p: 3 };
const KEYLEN = 64;
const MAXMEM = 128 * 1024 * 1024;

function scrypt(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, KEYLEN, { N, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hash(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt}$${key.toString('hex')}`;
}

function parse(stored) {
  const s = String(stored || '');
  if (s.startsWith('scrypt$')) {
    const [, N, r, p, salt, h] = s.split('$');
    return { params: { N: Number(N), r: Number(r), p: Number(p) }, salt, hash: h };
  }
  const parts = s.split(':');
  if (parts.length === 2 && /^[0-9a-f]+$/i.test(parts[0]) && /^[0-9a-f]{128}$/i.test(parts[1])) {
    return { params: { N: 16384, r: 8, p: 1 }, salt: parts[0], hash: parts[1], legacy: true };
  }
  return null;
}

async function verify(password, stored) {
  const parsed = parse(stored);
  if (!parsed) return false;
  try {
    const key = await scrypt(password, parsed.salt, parsed.params);
    const expected = Buffer.from(parsed.hash, 'hex');
    return expected.length === key.length && crypto.timingSafeEqual(expected, key);
  } catch {
    return false;
  }
}

function needsRehash(stored) {
  const parsed = parse(stored);
  if (!parsed || parsed.legacy) return true;
  return parsed.params.N < PARAMS.N || parsed.params.r !== PARAMS.r || parsed.params.p < PARAMS.p;
}

/** Same rules everywhere a password is set: length only (NIST 800-63B), 12-128 chars. */
function assertAcceptable(password) {
  if (typeof password !== 'string') throw badRequest('Password is required');
  if (password.length < 12) throw badRequest('Password must be at least 12 characters');
  if (password.length > 128) throw badRequest('Password must be at most 128 characters');
}

// Verified against for unknown usernames, so they cost the same time as real ones.
let dummyHash = null;
async function dummyVerify(password) {
  if (!dummyHash) dummyHash = await hash(crypto.randomBytes(16).toString('hex'));
  await verify(password, dummyHash);
  return false;
}

module.exports = { hash, verify, needsRehash, assertAcceptable, dummyVerify, parse };
