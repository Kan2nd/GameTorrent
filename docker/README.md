# Docker deployment (current, live)

This is the **current** way GameTorrent runs in production — plain Docker + Docker Compose,
orchestrated by Komodo (GitOps). See [`../k8s/`](../k8s/) for the k3s-based deployment being
prepared alongside this one (not live yet — see `docs/K8S_MIGRATION.md`).

| File | What it is |
|---|---|
| [`webui-compose.yml`](webui-compose.yml) | The web UI's deploy target. Komodo's `gametorrent-webui` Stack (`cicd/gitops/stacks.toml`) deploys exactly this file on every merge to `main`. Can also be run by hand — see the comment at the top of the file. |
| [`poc-compose.yml`](poc-compose.yml) | Deploy target for the CLI image. Not currently wired up (the CI job that would use it is disabled — see `docs/CI_CD.md`). |
| [`webhook-proxy/`](webhook-proxy/) | The Caddy proxy that's the *only* thing the public Cloudflare tunnel reaches — forwards just the Komodo deploy webhook, nothing else. See `docs/CLOUDFLARE_TUNNEL.md`. |
| [`host/`](host/) | Files installed directly on the VM (not in a container): the nightly backup timer, which now backs up the live k3s PVCs (the tunnel watchdog is retired). See its own README. |

**Why these moved here (2026-10):** they used to live scattered across `webui/`, `cicd/deploy/`
and `cicd/gitops/webhook-proxy/`. Consolidating them under `docker/` — mirroring the new `k8s/` —
makes it obvious which files belong to which deployment method while both exist side by side.

**What did *not* move:** the `Dockerfile`s themselves (repo root and `webui/Dockerfile`) stay next
to the source they build, since CI (`cicd/.gitlab-ci.yml`) and `webui-compose.yml`'s `build:`
section both reference them by path and they're build recipes, not deployment config. Komodo's
own bootstrap (`cicd/gitops/compose.yaml`, `compose.env.example`, `stacks.toml`) also stays in
`cicd/gitops/` — that's "how to stand up the GitOps controller," a layer above either deployment
method.

**Moving this file changed a live system.** `cicd/gitops/stacks.toml`'s `run_directory`/`file_paths`
were updated to match (`docker` / `webui-compose.yml`). Komodo's Resource Sync re-reads that file
from `main`, so **this takes effect only once this change is merged** — same rule as everything
else here (commit/push `dev`, the user merges `main`). After merging, confirm Komodo's
`gametorrent-webui` Stack still shows `docker/webui-compose.yml` as its source and that the next
deploy (push a trivial change, or trigger one manually in Komodo) still works before assuming it's fine.
