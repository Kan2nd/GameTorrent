# GitOps deployment (Komodo)

**Status: live.** `gametorrent-webui` on `kan2server` is deployed and
redeployed through Komodo, not manual `docker build`/`docker run` over SSH.
This doc describes the actual working setup — what it took to get there,
including two real bugs hit along the way — not just the original plan.

Why not Argo CD: it's a Kubernetes controller, and this project deliberately
dropped Kubernetes for plain Docker (the second homelab VM once earmarked
as a k8s control-plane node is now powered off and unused — see
`docs/PROJECT_STRUCTURE.md`). [Komodo](https://komo.do) gives the same
core idea — a git repo is the source of truth, a controller reconciles the
running deployment to match it — without needing a cluster: it runs as a
few containers directly on the existing Docker host.

## 1. Komodo itself: FerretDB, not MongoDB

`cicd/gitops/compose.yaml` runs Postgres+FerretDB, Core, and Periphery.
The official quickstart uses plain MongoDB — that failed outright on this
VM's kernel (7.0.0): `"Linux kernel versions 6.19 and newer has a known
incompatibility with this version of MongoDB"` (SERVER-121912). FerretDB
(Mongo-wire-compatible, Postgres-backed) is Komodo's own documented
alternative for exactly this case. `KOMODO_DATABASE_ADDRESS` points at
`ferretdb:27017` instead of `mongo:27017`; everything else is the
official compose file unchanged.

Deploy: fill in `cicd/gitops/compose.env.example` → `compose.env` (real
secrets, gitignored, recorded in `credentials.md`) on the host under
`/etc/komodo/`, then `docker compose -p komodo -f compose.yaml --env-file
compose.env up -d`. Confirm at `http://<host>:9120` — `KOMODO_FIRST_SERVER_NAME`
auto-registers the Docker host as a Server once Periphery connects; no
manual server setup needed.

## 2. Git account

Settings → Providers → Git Accounts → New Account. The one non-obvious
part: for GitLab, the **username field must literally be `oauth2`**, not
your real GitLab username — that's GitLab's HTTPS personal-access-token
auth convention (same as `git push https://oauth2:$TOKEN@gitlab.com/...`).
Using your actual username here fails with a 401. Token = a GitLab PAT
with `read_repository` (the one in `D:\STUDY\Sem alone\gitlantoken.md`,
reused from the separate `devsecops-pipeline` project rather than
minted fresh — same account, `api`-scoped, works fine for this too).

## 3. Variables (secrets)

Settings → Variables: `WEBUI_USER`, `WEBUI_PASSWORD`, `SESSION_SECRET`,
`VT_API_KEY` — reuse the exact values already in `credentials.md` so
taking over from the manual deployment doesn't invalidate the current
login. `stacks.toml`'s `environment` field references these as
`[[WEBUI_PASSWORD]]` etc.; Komodo resolves them at deploy time and writes
the result to a `.env` file on the host — the real values never touch git.

**Bug hit here:** a Variable with an **empty string value** marked
`is_secret: true` breaks deploy log rendering entirely. Komodo's log
redaction does a blind find-and-replace of the secret's value with a
placeholder — for an empty string, that matches *between every single
character* of the log, turning it to unreadable noise (`<VT_API_KEY>n<VT_API_KEY>a<VT_API_KEY>m...`).
Since `VT_API_KEY` is optional and unset, there's nothing sensitive in an
empty value anyway — mark it **not secret** and the problem disappears.

## 4. The Stack

`cicd/gitops/stacks.toml` declares `gametorrent-webui` as a git-backed
Stack pointing at this repo's `webui/docker-compose.yml`. Two config
fields are load-bearing and easy to miss:

```toml
run_build = true
auto_pull = false
```

This project has no image registry — `webui/docker-compose.yml` only has
a local `build:` context. Komodo's default assumes a registry image and
runs `docker compose pull` before `up`; without a registry, that fails
with `"repository does not exist"`, **even after `run_build = true`
already built the image successfully** — `run_build` adds a build step,
it doesn't remove the separate pull step. Both flags together are
required.

## 5. First deploy, and the container-name handoff

Deploying for the first time hit one more expected snag: the container
name `gametorrent-webui` was still held by the old manually-`docker run`
container from before Komodo existed. Komodo can't reuse a name it didn't
create. Fix: `docker rm -f gametorrent-webui` on the host once, then
redeploy — safe because `webui/docker-compose.yml` declares its volumes
`external: true`, so the existing `gametorrent-webui-data`/`-downloads`/
`-roms` volumes (and all their data) are untouched; only the container
itself gets replaced.

After that, **stop managing `gametorrent-webui` with raw `docker run`
over SSH** — `credentials.md`'s old "How to rotate" recipe for it is
superseded by "update the Komodo Variable, then redeploy."

## 6. Redeploying (the actual GitOps loop, today)

`poll_for_updates = false`, `auto_update = false`, no webhook configured —
redeploy is a manual **Deploy** click in Komodo's UI (Stacks →
`gametorrent-webui` → Deploy) or the equivalent API call, after a push to
`main`.

**Update (2026-09-17): a GitLab webhook is live and confirmed working** —
pushes to `main` do trigger a real deploy. Getting the webhook *delivered*
needed solving the exposure problem — `gitlab.com` can't reach a private
LAN address like `192.168.96.145` directly. Solution: a Cloudflare quick
tunnel.

```bash
# on kan2server — installs cloudflared and runs it as a systemd service
# pointed at Komodo Core, giving a public https://*.trycloudflare.com URL
curl -sSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i /tmp/cloudflared.deb
# then a systemd unit running: cloudflared tunnel --url http://localhost:9120
```

**Caveat, since there's no domain yet (free quick tunnel, not a named
one):** the public URL is random and changes every time the `cloudflared`
process restarts (VM reboot, service restart, crash) — `Restart=always`
keeps the *service* up, but a fresh restart still gets a new hostname,
which then needs updating on both the GitLab webhook and, if you ever
reference it elsewhere. Once a domain is bought, switch to a **named**
Cloudflare Tunnel (`cloudflared tunnel login` + `create`, bound to a real
subdomain) for a URL that survives restarts.

**Quick tunnels can also die on their own.** Seen 2026-09-19: the service
was `active` but the log filled with `Register tunnel error ... Unauthorized:
Tunnel not found` — Cloudflare had deleted the quick tunnel — so GitLab's
webhook deliveries showed *internal error* and nothing deployed. Fix:
`sudo systemctl restart cloudflared-komodo-tunnel`, read the new URL from
`sudo journalctl -u cloudflared-komodo-tunnel | grep trycloudflare`, then
repoint the hook (`PUT /projects/:id/hooks/:hook_id` with the new `url` **and
the same `token`, every time** — a PUT with only `url` silently leaves the hook
sending the wrong secret, so Komodo answers **HTTP 401** to every push and
nothing deploys; seen 2026-09-20. Recent events in GitLab showing 401 = secret
mismatch, `internal error` = dead tunnel), then trigger a deploy for the push that was missed.
GitLab's `POST .../hooks/:hook_id/test/push_events` can answer **422**
(seen 2026-09-20), so the dependable way is to send Komodo the request
GitLab would have — straight to the listener, secret in `X-Gitlab-Token`:

```bash
curl -X POST "https://<tunnel-host>/listener/gitlab/stack/gametorrent-webui/deploy"   -H "Content-Type: application/json" -H "X-Gitlab-Token: <KOMODO_WEBHOOK_SECRET>"   -d '{"object_kind":"push","ref":"refs/heads/main"}'   # HTTP 200 = deploy started
```

(A VM reboot restarts the quick tunnel with a new URL *and* can leave it in
the "Tunnel not found" state, so after any reboot check the tunnel first.)
Check delivery health any time under GitLab → Settings → Webhooks →
Recent events, or `GET .../hooks/:hook_id/events`.

The webhook itself, once the tunnel URL is known:

```bash
curl --header "PRIVATE-TOKEN: <gitlab-token>" -X POST \
  "https://gitlab.com/api/v4/projects/<namespace>%2F<repo>/hooks" \
  --data-urlencode "url=https://<tunnel-host>/listener/gitlab/stack/gametorrent-webui/deploy" \
  --data-urlencode "token=<KOMODO_WEBHOOK_SECRET>" \
  --data-urlencode "push_events=true" \
  --data-urlencode "push_events_branch_filter=main"
```

Komodo's webhook URL pattern is `/listener/gitlab/stack/<id-or-name>/deploy`
(GitHub uses `/listener/github/...` instead, with a different signature
scheme).

**Bug hit and fixed — `webhook_force_deploy` must be `true`:** by default,
a Stack's webhook doesn't run a plain deploy — it runs `DeployStackIfChanged`,
which compares a **cached** `latest_hash` against `deployed_hash` and skips
deploying if they already look equal. That cache only refreshes on
Komodo's own poll interval (`resource_poll_interval: OneHour` by default)
unless something explicitly refreshes it, so a webhook arriving between
poll cycles can compare against stale data and silently decide "nothing
changed" — even though a genuinely new commit exists. Symptom: GitLab
delivers successfully (HTTP 200), Komodo Core logs `"Successfully
authenticated incoming webhook"`, and then nothing — no deploy, no error,
no further log line at any level (confirmed with `KOMODO_LOGGING_LEVEL=debug`).
Read Komodo v2.3.3's actual source for this path
(`bin/core/src/api/listener/resources.rs`'s `DeployStack::resolve`) to
find it: `if stack.config.webhook_force_deploy { ...plain DeployStack... }
else { ...DeployStackIfChanged... }`.

Fix: set `webhook_force_deploy = true` on the stack (also added to
`cicd/gitops/stacks.toml` — it's a real config field, not just an API
tweak). This makes every webhook call an unconditional plain `DeployStack`,
identical to a manual Deploy click, bypassing the stale-cache class of
bug entirely. Confirmed working end-to-end: pushed a real commit to
`main`, fired the webhook, `deployed_hash` updated to match and the
container was recreated within ~10 seconds — **the fix that didn't show
up in `ListUpdates`/`GetUpdate` at all** (that read endpoint apparently
doesn't list this Stack's webhook-triggered updates the same way it does
manually-triggered ones, at least not within the query shape used here);
the *stack's own state* (`deployed_hash`, container creation timestamp,
and the app actually serving the new code) is the reliable way to check
whether a deploy ran, not `ListUpdates`.

Either way, a Deploy — manual or webhook-triggered — beats the old flow:
a diff of what changed, one-click rollback to any previous deploy, and
logs, all in one place.

## Scripting against Komodo directly (used to set all this up)

Komodo's UI is built on the same API available for scripting — useful
when clicking through Mantine-based dropdown/tab components doesn't
cooperate with browser automation (hit repeatedly setting this up).

```bash
# Auth: returns a JWT, also cached client-side in localStorage under mogh-auth-tokens-v1
curl -X POST http://<host>:9120/auth/login/LoginLocalUser \
  -H "Content-Type: application/json" \
  -d '{"username":"...","password":"..."}'

# Everything else: POST /read|write|execute/<RequestType>, body = params directly
# (NOT {type, params} — that wrapper is the Rust client crate's shape, not the wire format)
curl -X POST http://<host>:9120/write/CreateVariable \
  -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" \
  -d '{"name":"...","value":"...","is_secret":true,"description":"..."}'

curl -X POST http://<host>:9120/execute/DeployStack \
  -H "Authorization: Bearer <jwt>" -H "Content-Type: application/json" \
  -d '{"stack":"gametorrent-webui"}'
```

`GetUpdate` (read) with the deploy's `_id` polls status/logs until
`"status":"Complete"`.

## Separate issue: Docker networking wedges after any network blip

Not a Komodo problem — see `docs/PROJECT_STRUCTURE.md`'s "Recurring issue"
note. `kan2server`'s NIC flaps (and always does on VM pause/resume), which
leaves Docker's port-forwarding stuck for **every** container, Komodo's
own included, until `systemctl restart docker`. A `networkd-dispatcher`
hook now does that automatically — see that doc for the full explanation
and the fix.

## How this relates to `cicd/.gitlab-ci.yml`'s (disabled) deploy job

`.deploy:docker-compose` in the CI pipeline targets the **poc CLI image**
(`gametorrent-poc`), a separate concern from the web UI — it's unrelated
to this Komodo setup and can stay disabled/unfinished independently.
Komodo is the deploy path for `gametorrent-webui` specifically.
