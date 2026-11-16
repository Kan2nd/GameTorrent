#!/usr/bin/env node
/**
 * Static checks on the Kubernetes manifests. No cluster, no network.
 *
 *   node cicd/tests/manifest-selftest.js
 *
 * 1. Every `image:` under k8s/ is pinned by digest (`@sha256:<64 hex>`). The one exception is the
 *    webui image, which deployment.yaml names by a placeholder tag on purpose: its digest comes
 *    from the kustomize `images:` entry in k8s/webui/kustomization.yaml, and this test requires
 *    that entry to exist and hold a valid digest. (A floating tag is how a rebuilt image once sat
 *    unused for days: Argo CD never restarts a pod because a tag moved.)
 * 2. No `:latest` anywhere.
 * 3. Containers never run privileged, and none adds a capability outside a short allowlist
 *    (each addition is a deliberate, commented exception in its manifest).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const K8S = path.join(__dirname, '..', '..', 'k8s');
const WEBUI_IMAGE = 'registry.gitlab.com/kannguyen3105/gametorrent/webui';
const ALLOWED_CAPS = new Set(['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID']);
const DIGEST = /@sha256:[0-9a-f]{64}$/;

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : p.endsWith('.yaml') ? [p] : [];
  });
}

const files = walk(K8S).filter((f) => !/secret\.yaml$/.test(f)); // real secrets are gitignored anyway
const rel = (f) => path.relative(path.join(K8S, '..'), f).split(path.sep).join('/');

const kustomization = fs.readFileSync(path.join(K8S, 'webui', 'kustomization.yaml'), 'utf8');
const pin = kustomization.match(new RegExp(`name: ${WEBUI_IMAGE.replace(/[./]/g, '\\$&')}\\s*\\r?\\n(?:\\s*#[^\\n]*\\n)*\\s*digest: (sha256:[0-9a-f]{64})`));
check('webui image digest pin exists in k8s/webui/kustomization.yaml', !!pin, pin ? pin[1].slice(0, 19) + '...' : 'no `digest:` under images:');

let images = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = line.match(/^\s*(?:-\s*)?image:\s*([^\s#]+)/);
    if (!m) return;
    images++;
    const image = m[1];
    const where = `${rel(f)}:${i + 1}`;
    if (image.startsWith(`${WEBUI_IMAGE}:`)) {
      check(`${where} webui image is the placeholder replaced by the kustomize pin`, !!pin);
    } else {
      check(`${where} ${image.split('@')[0]} pinned by digest`, DIGEST.test(image));
    }
    check(`${where} not :latest`, !/:latest(@|$)/.test(image));
  });
}
check('found images to check', images >= 12, `${images} image lines`);

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  if (/privileged:\s*true/.test(text)) check(`${rel(f)} has no privileged container`, false);
  for (const m of text.matchAll(/add:\s*\[([^\]]*)\]/g)) {
    for (const cap of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
      check(`${rel(f)} capability ${cap} is on the allowlist`, ALLOWED_CAPS.has(cap));
    }
  }
}

console.log(failures ? `\n${failures} manifest check(s) FAILED` : '\nall manifest checks passed');
process.exit(failures ? 1 : 0);
