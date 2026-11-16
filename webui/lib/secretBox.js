'use strict';

/**
 * Encrypts small secrets (the Jackett API key) before they're stored in the database:
 * AES-256-GCM, key from DATA_ENCRYPTION_KEY (64 hex chars = 32 bytes, from the k8s Secret).
 *
 * What this protects: a database dump or backup on its own doesn't reveal the key. What it
 * doesn't: a fully compromised webui pod has both the ciphertext and the key in memory.
 * Stored format: 'v1:<iv b64>:<tag b64>:<ciphertext b64>'.
 */

const crypto = require('crypto');

// GCM's tag length is pinned on both sides. Without it, Node accepts a shorter tag on decrypt,
// which makes forging a ciphertext far easier (semgrep gcm-no-tag-length, 2026-11-05).
const TAG_LENGTH = 16;

function key() {
  const hex = process.env.DATA_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('DATA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  return Buffer.from(hex, 'hex');
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv, { authTagLength: TAG_LENGTH });
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(stored) {
  const [v, iv, tag, ct] = String(stored).split(':');
  if (v !== 'v1') throw new Error('Unknown encrypted value format');
  const tagBuf = Buffer.from(String(tag), 'base64');
  if (tagBuf.length !== TAG_LENGTH) throw new Error('Encrypted value has a wrong-length authentication tag');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'), { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tagBuf);
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, assertKey: key };
