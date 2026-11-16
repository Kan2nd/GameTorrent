#!/usr/bin/env node
/**
 * Security regression tests for the fixes from the 2026-10 audit (see log/ locally).
 * No network needed: the only HTTP server is a throwaway one on 127.0.0.1. Run from the repo
 * root after `npm ci` in poc/:   node cicd/tests/security-selftest.js
 * Exits non-zero if any check fails, so CI turns red if a fix is ever undone.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { EventEmitter } = require('events');

process.env.ALLOW_PRIVATE_FETCH = ''; // make sure the guard is ON for the unit checks
const p = require('../../poc/pipeline');

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
function throws(fn) { try { fn(); return false; } catch { return true; } }

// --- C1: download folder / platform names must be single plain names ---
const magnet = { magnetUri: 'magnet:?xt=urn:btih:' + '0'.repeat(40) };
check('C1 plain folder accepted', !throws(() => p.buildJobFromParams({ ...magnet, destSubfolder: 'zelda-minish_cap.1', platform: 'gba' })));
for (const bad of ['..', '.', 'a/b', 'a\\b', '', 'x'.repeat(200)]) {
  check(`C1 folder rejected: ${JSON.stringify(bad.slice(0, 20))}`, throws(() => p.buildJobFromParams({ ...magnet, destSubfolder: bad })));
}
for (const bad of ['GBA', 'gba/x', '..', 'a b']) {
  check(`C1 platform rejected: ${JSON.stringify(bad)}`, throws(() => p.buildJobFromParams({ ...magnet, destSubfolder: 'ok', platform: bad })));
}
const feedWith = (destSubfolder) => ({ games: [{
  id: 'g', title: 't', platform: 'gba', source: { type: 'magnet', magnetUri: magnet.magnetUri },
  extraction: { destSubfolder }, launch: {},
}] });
// Positive control first, so the rejection below can't pass for some unrelated reason.
check('C1 feed entry with good folder accepted', !throws(() => p.buildJobFromGameId('g', feedWith('good-folder'))));
check('C1 feed entry with bad folder rejected', throws(() => p.buildJobFromGameId('g', feedWith('../x'))));

// --- M1: outbound fetches must not reach private/internal addresses ---
for (const u of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://100.64.0.1/', 'file:///etc/passwd', 'ftp://example.org/']) {
  check(`M1 blocked: ${u}`, throws(() => p.assertFetchAllowed(u)));
}
check('M1 public URL allowed', !throws(() => p.assertFetchAllowed('https://example.org/feed.json')));

async function asyncChecks() {
  // M1: a hostname that RESOLVES to loopback is refused at connect time.
  await new Promise((resolve) => p.guardedLookup('localhost', {}, (err) => { check('M1 DNS name resolving to loopback refused', !!err); resolve(); }));

  // C1: direct-URL filenames always land inside their own folder (local server, guard off for this part).
  process.env.ALLOW_PRIVATE_FETCH = '1';
  const server = http.createServer((req, res) => res.end('x')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const dest = `selftest-${process.pid}`;
  for (const seg of ['plain.gba', '..%2Fescape.gba', '%2e%2e', 'a%5Cb.gba']) {
    const r = await p.downloadDirect({ destSubfolder: dest, directUrl: `http://127.0.0.1:${port}/${seg}` }, new EventEmitter());
    const written = path.resolve(r.outDir, r.files[0]);
    check(`C1 URL filename stays inside: ${seg}`, written.startsWith(path.resolve(p.DOWNLOADS_DIR, dest) + path.sep), path.basename(written));
  }
  fs.rmSync(path.join(p.DOWNLOADS_DIR, dest), { recursive: true, force: true });
  server.close();
  process.env.ALLOW_PRIVATE_FETCH = '';

  // M1: with the guard on, a local server is refused.
  const s2 = http.createServer((req, res) => res.end('x')).listen(0, '127.0.0.1');
  await new Promise((r) => s2.once('listening', r));
  const refused = await p.downloadDirect({ destSubfolder: `selftest2-${process.pid}`, directUrl: `http://127.0.0.1:${s2.address().port}/a.gba` }, new EventEmitter())
    .then(() => false, () => true);
  check('M1 download from a private address refused', refused);
  fs.rmSync(path.join(p.DOWNLOADS_DIR, `selftest2-${process.pid}`), { recursive: true, force: true });
  s2.close();

  // M5: zips containing symlink entries are refused (hand-built zip, no extra tooling needed).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zipselftest-'));
  const zipPath = path.join(tmp, 'symlink.zip');
  fs.writeFileSync(zipPath, buildZip([{ name: 'link', data: Buffer.from('elsewhere'), symlink: true }]));
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'poc', 'pipeline.js'), 'utf8');
  const extractZip = require('../../poc/node_modules/extract-zip');
  // eslint-disable-next-line no-new-func
  const safeExtractZip = new Function('extractZip', `${src.match(/function safeExtractZip[\s\S]*?\n}\n/)[0]}; return safeExtractZip;`)(extractZip);
  const zipRefused = await safeExtractZip(zipPath, path.join(tmp, 'out')).then(() => false, () => true);
  check('M5 zip with a symlink entry refused', zipRefused);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/** Minimal stored (uncompressed) zip writer — just enough to mark an entry as a symlink. */
function buildZip(entries) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = []; const centrals = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name); const crc = crc32(e.data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(e.data.length, 20); central.writeUInt32LE(e.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, e.data); centrals.push(central, name);
    offset += local.length + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

asyncChecks().then(() => {
  console.log(failures ? `\n${failures} security check(s) FAILED` : '\nall security checks passed');
  process.exit(failures ? 1 : 0);
}, (err) => { console.error(err); process.exit(1); });
