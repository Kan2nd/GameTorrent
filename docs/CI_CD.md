# CI/CD — Branch Strategy & Pipeline

CI/CD is kept deliberately separate from day-to-day development: all
pipeline config and tooling lives in a dedicated [`cicd/`](../cicd) folder
(`cicd/.gitlab-ci.yml`, `cicd/package.json`, `cicd/scripts/validate-catalog.js`,
`cicd/ansible/`, `docker/`) rather than inside `poc/` or `apps/desktop/`,
and it only engages at specific branch boundaries — not on every commit you
push while working.

**History note:** the security-scanning stages (SAST, dependency scan, image
scan) and the Docker deploy tooling (`cicd/ansible/`, `docker/`) were
originally a separate project (`devsecops-pipeline`) that kept its own copy
of this code just to scan it, and originally deployed to a Kubernetes
cluster. Both were dropped: k8s was more than this project needs (the target
VM is meant to become a plain Docker + Compose + Portainer homelab box), and
once merged into this repo there's no more need for a separate copy — the
security jobs scan `poc/` directly. See
[`docs/devsecops-notes/`](devsecops-notes) for that project's original
tutorial/history, kept as reference, not as the current setup.

**GitLab setup note:** GitLab looks for `.gitlab-ci.yml` at the repo root
by default. Since it lives at `cicd/.gitlab-ci.yml` here, the project's
**Settings → CI/CD → General pipelines → CI/CD configuration file** must be
`cicd/.gitlab-ci.yml`. **Until 2026-10-01 it was empty, so no pipeline ever
ran** — every "gate" below existed on paper only. It's set now. Pipeline jobs
run with the repo root as their working directory, so job scripts `cd cicd`
before running anything cicd-local (e.g. `npm ci`).

**Merge gate:** Settings → Merge requests → *Pipelines must succeed* is on, so
an MR into `main` can't be merged unless this pipeline is green. Merging into
`main` is what triggers the Argo CD deploy (`docs/K8S_MIGRATION.md`), so every gate
below sits in front of production.

## Branches

| Branch | Purpose | Pipeline behavior |
|---|---|---|
| `feature/*` | Day-to-day work. Branch off `dev` for any change. | **No pipeline** on plain pushes — push as often as you want with zero CI overhead. |
| `dev` | Integration branch. `feature/*` branches merge here via MR. | Full pipeline (all security gates) on every MR into `dev` and every push to `dev`. |
| `main` | Release branch. `dev` merges here when ready to ship. | Full pipeline must pass before the MR can merge; the merge then triggers the Argo CD deploy. |

This means CI only ever runs in two situations: someone opens an MR (into
`dev` or `main`), or a push lands directly on `dev`/`main`. Feature branches
are yours to force-push, rebase, or leave broken without touching the
pipeline at all.

## Pipeline stages

**Every security gate is blocking.** An accepted risk goes in `.trivyignore`
(with the reason, the evidence, and an expiry date) or as a `nosemgrep`
comment with the reason next to it — never by setting `allow_failure: true`.
Every scanner image is pinned to an exact version so two runs of the same
commit give the same answer.

1. **validate**
   - `validate:catalog` — validates `catalog/catalog.json` (and any
     `catalog/feeds/*.json`) against `catalog/catalog.schema.json` via
     `npm run validate:catalog`. Catches malformed catalog entries before
     they reach the app.
   - `validate:syntax` — `node --check` on every JS file in `poc/`,
     `webui/` and `cicd/tests/`.
2. **test** — `test:security`: `cicd/tests/security-selftest.js`, regression
   tests for the 2026-10 audit fixes (path traversal in download paths, the
   SSRF guard, zip symlink entries), and `cicd/tests/api-selftest.js`. The
   latter gets a throwaway Postgres as a job `services:` container, builds it
   with the production role setup (`k8s/postgres/init-roles.sql` + migrations),
   imports fake legacy JSON, starts the real webui and attacks it over HTTP:
   file-download traversal, session revocation (disable/demote/delete/reset),
   login lockout, sign-up approval, the last-admin race, scan options on
   requests, audit-log immutability, cross-site guard, unknown-console handling, provider editing (87 checks). Needs no
   network beyond `npm ci`. `cicd/tests/search-selftest.js` (no database)
   checks the typo-tolerant matcher and the search widening.
3. **sast**
   - `secret-scan` — gitleaks over the **full** git history (`GIT_DEPTH: 0`):
     a secret that was committed and later deleted is still leaked.
   - `semgrep-sast` — OWASP Top Ten + JavaScript + nodejsscan rules over
     `poc/`, `webui/` **and** `cicd/tests/`. (It used to scan `poc/` only;
     `webui/` is the part reachable over the network.)
4. **dependency-scan** — `trivy-fs`: every `package-lock.json` for vulnerable
   packages, plus the Dockerfiles for misconfigurations (IaC scanning).
   No `--ignore-unfixed`: an app dependency with no fix must be consciously
   accepted in `.trivyignore`.
5. **build** — `build-image`: builds `webui/Dockerfile` — the image Argo CD
   actually deploys — and passes the exact bytes (`image.tar.gz`) on.
6. **image-scan** — `trivy-image`: OS + app vulnerabilities inside that image,
   and a CycloneDX **SBOM** (`reports/sbom.cdx.json`, kept 1 month).
   `--ignore-unfixed` here only, because Debian ships base-OS CVEs with no fixed
   package that nobody can act on; anything fixable still fails the build.
7. **registry** — `push-image` (on `dev`/`main` only): loads the exact
   `image.tar.gz` `build-image` produced and `trivy-image` scanned — never
   rebuilds — and pushes it to this project's own GitLab Container Registry as
   `$CI_REGISTRY_IMAGE/webui`, tagged both by commit SHA (immutable) and by
   branch name (`:dev`/`:main`, floating — convenient for humans, but **nothing
   deploys from it**: the cluster runs the exact digest pinned in
   `k8s/webui/kustomization.yaml`, see "Releasing" below).
   No new secret needed: `CI_REGISTRY_USER`/`CI_REGISTRY_PASSWORD` are GitLab
   predefined variables, scoped to this project's registry only.

   `sign-image` (same stage, after `push-image`) — signs the commit-SHA tag with
   **cosign** using a key only the repo owner generates (`docs/TUTORIALS.md` §2).
   **Dormant right now:** its rule requires the `COSIGN_PRIVATE_KEY` CI/CD variable
   to exist, and it doesn't yet, so the job is skipped rather than failing. Once the
   variables are created as **Protected**, it runs on `main` only — `dev` is not a
   protected branch in this project, so protected variables are never exposed to
   `dev` pipelines. Note the signature is evidence, not yet a control: nothing in the
   cluster refuses an unsigned image (see `docs/K8S_MIGRATION.md`'s security-review
   section).
8. **deploy**
   - Nothing pushes to the cluster from CI. Argo CD *pulls* from `main` (polls
     every ~3 min) — merging into `main` is the deploy.
   - `deploy:tauri-placeholder` — manual, `main`-only. Phase 2 will replace
     it with `tauri build` + publishing a GitLab Release with the generated
     desktop installers. Because it's the only job left pending, GitLab shows the
     whole pipeline as **`manual`** even when every real gate passed — check the
     per-job list, not the summary (`docs/DEBUG.md` Part 1 §10).
   - `.deploy:docker-compose`, disabled — pushes the built image to a plain
     Docker host (`cicd/ansible/` installs Docker + Compose there,
     `docker/poc-compose.yml` is the run target) over SSH. Needs
     `SSH_PRIVATE_KEY`/`DEPLOY_HOST`/`DEPLOY_USER`/`REGISTRY` CI/CD
     variables and a registry to push `image.tar` to — neither exists yet.

## Releasing (how a build reaches the cluster)

A moving tag can't deploy anything: Argo CD only acts when the *manifests in git* change, and a
rebuilt `:main` leaves them identical, so the old pod kept running (found 2026-11-04: the webui sat on
the vulnerable image after the fix merged). So the cluster runs an image named by **digest**, and
shipping a build means changing that digest in git:

1. Merge `dev` → `main`. CI builds, scans and pushes the image (tagged with the 8-char commit sha).
2. On `dev`: `git fetch`, then
   ```bash
   GITLAB_TOKEN=<read_registry or api token> node cicd/scripts/pin-webui-image.js
   ```
   It looks up the digest of `origin/main`'s build in the registry and rewrites the one `digest:` line
   (plus a `pinned-from` comment) in `k8s/webui/kustomization.yaml`. Pass a commit tag to pin an
   older build instead. Only builds that passed every gate are ever pushed, so a tag that exists is
   one that was vetted.
3. Commit that on `dev`, merge → Argo CD sees the changed digest and rolls the pod (about a minute of
   downtime; the webui is a single replica). Rolling **back** is `git revert` of that commit.

Why two merges rather than CI committing the digest itself: a bot writing to `main` would need a
write token stored in CI and would bypass the human merge on the branch that deploys. This way the
only thing that reaches `main` is something a person merged.

The pin covers both the app and its `db-migrate` initContainer (same image). Everything else in
`k8s/` is pinned by digest too, and `cicd/tests/manifest-selftest.js` (job `test:security`) fails the
pipeline if any image isn't, if one uses `:latest`, if the webui pin is missing, or if a container adds
a Linux capability outside a short allowlist (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, `SETGID`).
Bumping a third-party image (Loki, Grafana, Postgres, ...) is the same idea by hand: pull, read
`RepoDigests`, edit the line, let the test confirm it.

## Adding more tests

The `test` stage exists now (`test:security`). Add further test jobs there
rather than folding them into `validate` — keep schema/lint-style checks
(fast, no deps) separate from actual test runs.

## Running the scanners locally

The same pinned images work anywhere Docker runs (e.g. on the VM), which is how
the gates were triaged before being made blocking:

```bash
docker run --rm -v "$PWD":/repo -w /repo zricethezav/gitleaks:v8.30.1 git . --redact
docker run --rm -v "$PWD":/src -w /src semgrep/semgrep:1.178.0 semgrep scan \
  --config p/owasp-top-ten --config p/javascript --config p/nodejsscan --config p/ci \
  --severity ERROR --error --metrics off --exclude node_modules poc webui cicd/tests
docker run --rm -v "$PWD":/src -w /src aquasec/trivy:0.74.0 fs --scanners vuln,misconfig \
  --severity HIGH,CRITICAL --ignorefile .trivyignore --exit-code 1 .
```
