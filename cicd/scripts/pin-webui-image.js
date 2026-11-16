#!/usr/bin/env node
/**
 * Pins the webui image in k8s/webui/kustomization.yaml to the exact digest GitLab's registry holds
 * for a given commit's build, so Argo CD rolls the pod when (and only when) that line changes.
 *
 *   GITLAB_TOKEN=<token with read_registry or api scope> node cicd/scripts/pin-webui-image.js [ref]
 *
 * ref: a commit tag in the registry (the push-image job tags every build with the 8-char commit
 * sha). Default: the 8-char sha of origin/main, i.e. the build of whatever was merged last.
 * Only builds that passed every CI gate (scans, tests) ever get pushed, so a tag that exists is a
 * tag that was vetted. Prints what changed; never prints the token. Run it on `dev`, commit the
 * result, merge: see docs/CI_CD.md "Releasing".
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT = 'kannguyen3105/gametorrent';
const IMAGE = 'registry.gitlab.com/kannguyen3105/gametorrent/webui';
const KUSTOMIZATION = path.join(__dirname, '..', '..', 'k8s', 'webui', 'kustomization.yaml');

async function api(token, url) {
  const res = await fetch(`https://gitlab.com/api/v4${url}`, { headers: { 'PRIVATE-TOKEN': token } });
  if (!res.ok) throw new Error(`GitLab API ${res.status} for ${url.split('?')[0]}`);
  return res.json();
}

async function main() {
  const token = process.env.GITLAB_TOKEN;
  if (!token) throw new Error('Set GITLAB_TOKEN (a token with read_registry or api scope)');

  const ref = process.argv[2]
    || execFileSync('git', ['rev-parse', '--short=8', 'origin/main'], { encoding: 'utf8' }).trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(ref)) throw new Error(`Odd ref "${ref}"`);

  const project = encodeURIComponent(PROJECT);
  const repos = await api(token, `/projects/${project}/registry/repositories`);
  const repo = repos.find((r) => r.path.endsWith('/webui'));
  if (!repo) throw new Error('No webui repository in the registry');
  const tag = await api(token, `/projects/${project}/registry/repositories/${repo.id}/tags/${encodeURIComponent(ref)}`);
  if (!/^sha256:[0-9a-f]{64}$/.test(tag.digest || '')) throw new Error(`Registry returned no usable digest for ${ref}`);

  const text = fs.readFileSync(KUSTOMIZATION, 'utf8');
  const re = new RegExp(`(  - name: ${IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n)(    # pinned-from:[^\\r\\n]*\\r?\\n)(    digest: sha256:[0-9a-f]{64})`);
  const m = text.match(re);
  if (!m) throw new Error(`Could not find the pinned image block in ${path.relative(process.cwd(), KUSTOMIZATION)}`);
  const old = m[3].trim().replace('digest: ', '');
  const built = String(tag.created_at).slice(0, 10);
  const eol = m[2].endsWith('\r\n') ? '\r\n' : '\n';
  const next = `${m[1]}    # pinned-from: commit ${ref}, built ${built}${eol}    digest: ${tag.digest}`;
  fs.writeFileSync(KUSTOMIZATION, text.replace(re, () => next));

  console.log(old === tag.digest
    ? `Already pinned to ${tag.digest} (${ref}); nothing changed.`
    : `Pinned webui to ${tag.digest}\n  was: ${old}\n  from commit ${ref}, built ${built}\nNow: git add k8s/webui/kustomization.yaml, commit on dev, merge to roll it out.`);
}

main().catch((err) => { console.error(`pin-webui-image: ${err.message}`); process.exit(1); });
