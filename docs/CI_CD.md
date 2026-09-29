# CI/CD — Branch Strategy & Pipeline

CI/CD is kept deliberately separate from day-to-day development: all
pipeline config and tooling lives in a dedicated [`cicd/`](../cicd) folder
(`cicd/.gitlab-ci.yml`, `cicd/package.json`, `cicd/scripts/validate-catalog.js`,
`cicd/ansible/`, `cicd/deploy/`) rather than inside `poc/` or `apps/desktop/`,
and it only engages at specific branch boundaries — not on every commit you
push while working.

**History note:** the security-scanning stages (SAST, dependency scan, image
scan) and the Docker deploy tooling (`cicd/ansible/`, `cicd/deploy/`) were
originally a separate project (`devsecops-pipeline`) that kept its own copy
of this code just to scan it, and originally deployed to a Kubernetes
cluster. Both were dropped: k8s was more than this project needs (the target
VM is meant to become a plain Docker + Compose + Portainer homelab box), and
once merged into this repo there's no more need for a separate copy — the
security jobs scan `poc/` directly. See
[`docs/devsecops-notes/`](devsecops-notes) for that project's original
tutorial/history, kept as reference, not as the current setup.

**GitLab setup note:** GitLab looks for `.gitlab-ci.yml` at the repo root
by default. Since it lives at `cicd/.gitlab-ci.yml` here, once this repo is
pushed to GitLab you need to set **Settings → CI/CD → General pipelines →
CI/CD configuration file** to `cicd/.gitlab-ci.yml`. Pipeline jobs still run
with the repo root as their working directory either way, so job scripts
`cd cicd` before running anything cicd-local (e.g. `npm ci`).

## Branches

| Branch | Purpose | Pipeline behavior |
|---|---|---|
| `feature/*` | Day-to-day work. Branch off `dev` for any change. | **No pipeline** on plain pushes — push as often as you want with zero CI overhead. |
| `dev` | Integration branch. `feature/*` branches merge here via MR. | Full `validate` + `build` on every MR into `dev` and every push to `dev`. |
| `main` | Release branch. `dev` merges here when ready to ship. | `validate` + `build`, plus a `deploy` stage gated behind a manual trigger. |

This means CI only ever runs in two situations: someone opens an MR (into
`dev` or `main`), or a push lands directly on `dev`/`main`. Feature branches
are yours to force-push, rebase, or leave broken without touching the
pipeline at all.

## Pipeline stages

1. **validate** — always runs.
   - `validate:catalog` — validates `catalog/catalog.json` (and any
     `catalog/feeds/*.json`) against `catalog/catalog.schema.json` via
     `npm run validate:catalog`. Catches malformed catalog entries before
     they reach the app.
   - `validate:poc-syntax` — `node --check poc/poc.js`, a fast syntax
     sanity check on the Phase 1 PoC.
2. **sast** — `semgrep-sast`, active. Scans `poc/` for insecure code
   patterns (OWASP Top Ten + JS rules). Report-only (`allow_failure: true`)
   until triaged.
3. **dependency-scan** — `.trivy-dependency-scan`, disabled by default.
   Trivy fs scan of `poc/package-lock.json` for known-vulnerable npm
   packages — should currently catch `extract-zip`'s documented symlink
   path-traversal advisory (see `POC.md`).
4. **build**
   - `build:poc` — installs `poc/`'s dependencies (`npm ci`) to confirm the
     lockfile resolves cleanly.
   - `.build-image`, disabled — builds the repo-root `Dockerfile`
     (`node:20-alpine`) and saves it as `image.tar` for the next two stages.
5. **image-scan** — `.trivy-image-scan`, disabled, needs `.build-image`
   enabled first. Scans the built image's layers/base OS packages.
6. **deploy**
   - `deploy:tauri-placeholder` — manual, `main`-only. Phase 2 will replace
     it with `tauri build` + publishing a GitLab Release with the generated
     desktop installers.
   - `.deploy:docker-compose`, disabled — pushes the built image to a plain
     Docker host (`cicd/ansible/` installs Docker + Compose there,
     `cicd/deploy/docker-compose.yml` is the run target) over SSH. Needs
     `SSH_PRIVATE_KEY`/`DEPLOY_HOST`/`DEPLOY_USER`/`REGISTRY` CI/CD
     variables and a registry to push `image.tar` to — neither exists yet.

## Adding real tests later

There's no test suite yet (Phase 1 is a PoC). When one exists, add a
`test` stage between `build` and `deploy` rather than folding tests into
`validate` — keep schema/lint-style checks (fast, no deps needed beyond
`npm ci`) separate from actual test runs.
