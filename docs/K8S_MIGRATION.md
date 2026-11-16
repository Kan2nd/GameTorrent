# Docker → k3s: the migration plan (and what happened)

Status, 2026-11-04: **Migration complete; Phase 6 (logs + metrics + signing) in progress.**
Everything runs on k3s via Argo CD; Komodo and the Docker deployment are retired (Docker
containers stopped, not removed, as a rollback path). This doc started as a plan and now records
what actually happened, including the parts that went wrong. For "how do I check X right now"
see [`DEBUG.md`](DEBUG.md); for hands-on walkthroughs see [`TUTORIALS.md`](TUTORIALS.md).

| Phase | What | Status |
|---|---|---|
| 0 | Prerequisites | done |
| 1 | k3s + Cilium + Argo CD on the VM | done (2026-10-09/10) |
| 2 | CI pushes the image to GitLab's registry | done |
| 3 | Manifests | done |
| 4 | webui cut over | done (2026-10-10) |
| 5 | Jackett + Uptime Kuma cut over, Komodo retired | done (2026-10-13) |
| — | NetworkPolicy, metrics-server, Hubble Relay | done (2026-10-15/21) |
| 6 | Logs (Loki/Alloy) + metrics (Prometheus/kube-state-metrics) + Grafana + cosign image signing | in progress — see below |
| 7 | webui state moved from JSON files to PostgreSQL; sign-up + full account management | done (2026-11-05) — see below |
| 8 | Supply-chain + privilege hardening: every image pinned by digest, observability under Argo CD, Kuma non-root, Jackett down to 3 capabilities | done (2026-11-05) — see below |
| 9 | VM hardening: host firewall (ufw), Docker retired (installed, switched off), reboot onto the pending kernel | done (2026-11-05) — see below |

## Why, and why to be honest about the tradeoff

This project already dropped Kubernetes once (`docs/devsecops-notes/`, "too much" for a single
VM). Doing it again should be for a real reason, not just because Kubernetes is the famous name.
The actual reason here: **structure** — declarative manifests instead of a docker-compose file +
a GitOps tool built for Docker specifically (Komodo), self-healing primitives, and the standard
ecosystem (which matters if this project is partly about learning DevSecOps tooling).

What this move does **not** give: high availability. It's the same single VM, same single point
of failure, before and after. Kubernetes' resilience features (pod restarts, rollouts) help with
*software* failures, not *hardware* ones, on a single node. Worth remembering before the word
"Kubernetes" implies more robustness than a one-node cluster actually has.

## Phase 0 — Decide the shape, check the prerequisites (done)

- **GitOps tool: Argo CD**, not Flux. Reasoning: a web UI closer in spirit to what Komodo already
  gave the user, huge community/documentation, and — chosen deliberately — it **polls** the repo
  by default instead of needing a public webhook. That's a free side-effect fix for the recurring
  Cloudflare-tunnel pain in `docs/CLOUDFLARE_TUNNEL.md` and `log/L-low-findings.md` (L1): no
  public endpoint needed at all for this app's deploys, once it's on Argo CD. (Komodo's webhook
  stays as-is for the Docker deployment until/unless that's retired too.)
- **Scope: `gametorrent-webui` only, first.** Jackett, Uptime Kuma, and Komodo's own backing
  services stay on Docker. Decide whether to migrate them after this has run clean for a while —
  not bundled into this phase.
- **Hardware/software/network checked** against the real VM — see `k8s/REQUIREMENTS.md`. Two
  real problems found and fixed before anything else could safely proceed:
  - ~5GB of reclaimable Docker waste (leftover scanner images from the September audit, stale
    build cache) — removed.
  - The VM's root filesystem was using half of an already-allocated 48GB LVM volume group — the
    other 24GB had never been extended into it. Fixed online, zero downtime, no VMware-side disk
    resize needed. Root went from 2.9GB free to 31GB free.
- **Versions pinned:** k3s `v1.37.1+k3s1`, Argo CD `v3.5.4` (`cicd/ansible/roles/k3s/defaults/main.yml`).

## Phase 1 — Install k3s alongside Docker (done — CNI later switched from flannel to Cilium)

```bash
cd cicd/ansible
ansible-playbook -i inventory/hosts.ini k3s-playbook.yml
```

- Installs k3s (single-node) and Argo CD on `kan2server`, **next to** the existing Docker setup —
  nothing Docker-based is touched or stopped.
- The role re-checks free disk space itself and refuses to proceed if it's tight (`fail` task,
  10GB floor) rather than installing halfway and leaving a mess.
- Syntax-checked and `--list-tasks`-verified already (both the existing `playbook.yml` and the
  new `k3s-playbook.yml` parse correctly; the Docker playbook is provably untouched by this change
  — it's a separate file, not an added play in the existing one). **Not yet dry-run against a
  live cluster** — Argo CD's `Application` CRD in particular can't be schema-validated without a
  real API server to ask, so that validation happens naturally the first time this phase actually
  runs, not before.
- This is the step I'm holding for your explicit "go" — it adds a second container runtime and a
  new always-on GitOps controller to a server you rely on, which is a bigger commitment than
  anything file-only.

## Phase 2 — Container registry (done)

k3s pulls images from a registry; Komodo's Docker deployment builds locally and never needed one
(`run_build: true` in `cicd/gitops/stacks.toml`). Added `push-image` (`cicd/.gitlab-ci.yml`,
`registry` stage): loads the exact `image.tar.gz` that `build-image` produced and `trivy-image`
scanned, pushes it to this project's own GitLab Container Registry (already enabled, confirmed
via the API) as `$CI_REGISTRY_IMAGE/webui`, tagged by commit SHA **and** by branch name. No new
credential — `CI_REGISTRY_USER`/`PASSWORD` are GitLab-provided, scoped to this project's registry.

*(Superseded 2026-11-05, Phase 8: the webui is now pinned by digest in `k8s/webui/kustomization.yaml`;
the floating `:main` tag deployed nothing, since Argo CD never restarts a pod because a tag moved.
See `docs/CI_CD.md` "Releasing".)*

## Phase 3 — Manifests (done, files only)

`k8s/webui/` — `Deployment`, `Service`, 4 `PersistentVolumeClaim`s, a `Secret` template. Every
hardening control from `docker/webui-compose.yml` (`log/M3-container-hardening.md`) has a direct
k8s equivalent, applied here the same way: non-root user, read-only root filesystem, all
capabilities dropped, no privilege escalation, memory **and** CPU limits (the compose file had no
CPU limit — added here since it's free to set), and liveness/readiness probes translated from the
existing Docker healthcheck with matching timings. One k8s-native addition the Docker version
didn't have: an `initContainer` that fixes volume ownership to uid 1000 before the app starts —
the automated version of the one-time manual `chown` done during the M3 live cutover.

## Phase 4 — Cut over (done, 2026-10-10)

1. ~~Deploy to k3s on a different exposed port, against **fresh** PVCs — don't touch the live
   Docker volumes yet.~~ Done — tested via the pod's own IP / ClusterIP while Docker still held
   `:3000`.
2. ~~Smoke-test: login, a real download, ClamAV scanning, the audit log filling in.~~ Login,
   session and library content verified against the pod IP before cutover, then again against the
   real `:3000` address after.
3. ~~Copy data from the Docker named volumes into the new PVCs...~~ Done. `webui-data`,
   `webui-downloads` (7 files), `webui-roms` (4 files) all verified file-for-file (name + exact
   byte size) identical to the live Docker volumes before the Docker container was stopped. The
   PV-vs-volume `du -sb` totals were off by a small, constant amount (~52KB / ~32KB) — that's
   filesystem block/directory-overhead accounting (overlay vs ext4 local-path storage), not missing
   data; confirmed by the per-file comparison matching exactly.
4. ~~Stop the Docker container, point the real `:3000` at the k8s Deployment's `hostPort`.~~ Done.
   `docker stop gametorrent-webui` (not removed — trivial to restart if needed), then the k3s pod
   was deleted/recreated so its `hostPort: 3000` bind actually took effect (it silently no-ops
   while something else already holds the port). Verified end-to-end against the real
   `<vm-ip>:3000` and the Tailscale address: real login, real users, real library.
   Note: Cilium's hostPort doesn't show up as a normal `LISTEN` socket in `ss` — it's eBPF-redirected
   into the pod's netns, not a userspace bind — so `curl` is the real check, not `ss`.
5. ~~Decide what happens to `docker/webhook-proxy/`...~~ Done — retired. Argo CD's `Application`
   (`k8s/argocd/application.yaml`) is now applied and polling `main` every 3 minutes by default;
   no push-based sync was wired up, so the GitLab webhook, Cloudflare tunnel, and webhook-only
   proxy that existed purely for Komodo's push-deploy path all got deleted/stopped (see
   `docker/host/README.md` and `docs/GITOPS.md`'s updated status). This closes that attack
   surface entirely for this app rather than just narrowing it the way `log/C2`'s proxy did.
   Argo CD currently shows `ComparisonError: k8s/webui: app path does not exist` — expected and
   correct, since `main` doesn't have `k8s/` yet. It'll sync for real once `dev` is merged to
   `main` (your call, not done automatically — same gate Komodo's manual-merge-then-deploy had).

## Phase 5 — Jackett and Uptime Kuma into the cluster (done, 2026-10-13)

Why: Argo CD only manages Kubernetes resources — Jackett and Uptime Kuma were plain `docker run`
containers it can't see at all. Moving them in puts everything under the same GitOps loop and
gives Jackett a stable in-cluster address (`http://jackett:9117`), which fixes the root cause of
the stale-LAN-IP provider breakage (`credentials.md` Jackett section) instead of working around it.

Live on the cluster now, both serving real migrated data at their usual addresses
(`<vm-ip>:9117` / `:3001` — LAN IP, see `credentials.md` for the current one):

- `k8s/jackett/` and `k8s/uptime-kuma/` — PVC, Deployment, Service, kustomization each. Images
  pinned by digest to exactly what the Docker containers were running (Jackett
  `v0.24.2605-ls31`, Uptime Kuma `1.23.17` — Kuma 2.x is a separate DB-migrating upgrade, not
  part of this move).
- **Security note, found by testing, not assumed:** neither runs non-root, unlike the webui.
  Jackett's `s6-overlay` init needs root to drop to `PUID`/`PGID` itself — forcing non-root
  crashes it immediately (`s6-applyuidgid: fatal: unable to set supplementary group list`), an
  architectural fact of the image, not a permissions bug. Kuma's own Node code unconditionally
  re-`chown`s its data dir on every boot; an initContainer pre-chown didn't stop that, and
  adding back exactly `CAP_CHOWN` (same scoped pattern as Caddy's `NET_BIND_SERVICE` elsewhere
  in this repo) still didn't work — ambient capabilities don't reliably survive Node's own
  internal exec/spawn chain. Both run root now, which is parity with what Docker was already
  doing, not a regression from it. Documented inline in each `deployment.yaml`.
- **Jackett's probes target `/favicon.ico`, not `/UI/Login`** — the login page is a stateful
  "TestCookie" consent redirect that intermittently 400s on a real probe request (confirmed via
  `tcpdump`: never reproduced through dozens of manual `curl`s, only under kubelet's actual
  probe cadence). A static file sidesteps the statefulness entirely.
- `k8s/argocd/application-jackett.yaml`, `application-uptime-kuma.yaml` — applied; same
  `ComparisonError: app path does not exist` as the webui's until `dev` is merged to `main`.
- Data verified byte-for-byte (sha256, not just size) identical to the Docker volumes before
  the Docker containers were stopped (not removed — same rollback posture as Phase 4).
- Fixed while here: `k8s/webui/kustomization.yaml` listed the gitignored `secret.yaml`, so Argo
  CD could never have rendered it from a git checkout. Removed from `resources:` (the Secret is
  still applied by hand once).

Still open: GameTorrent's Search provider still points at a LAN IP for Jackett — switch it to
`http://jackett:9117` (stable in-cluster DNS) via Admin → Search (remove + re-add, same API
key — there's no edit endpoint). Same for the Kuma "GameTorrent Web UI" monitor, which still
targets a hardcoded LAN `:3000` address.

**Komodo: retired entirely (2026-10-13).** Nothing was left for it to deploy once Jackett and
Kuma moved too — `docker compose -p komodo down` (containers removed, Postgres/FerretDB/keys
volumes kept, untouched, in case the data's ever wanted again).

## Phase 6 — Logs, metrics and image signing (in progress, 2026-10-24 onward)

Deliberately done as hands-on tutorials (`docs/TUTORIALS.md`) rather than applied
automatically, so the owner knows each piece first-hand.

**Logging — `k8s/observability/`, own `observability` namespace.** Live since 2026-10-26,
hand-applied at first; handed to Argo CD on 2026-11-05 (Phase 8).
- **Loki** (`grafana/loki:3.7.9`) — log store, single-binary mode, filesystem storage on a 5Gi
  local-path PVC, 7-day retention. Single-binary is the right shape for one node; the
  microservices split earns nothing here.
- **Alloy** (`grafana/alloy:v1.21.2`) — the collector. Not Promtail (end-of-life since
  2026-03-02). Uses the API-based source (`loki.source.kubernetes`): reads logs the way
  `kubectl logs` does, so no privileged DaemonSet and no hostPath mount. Its ClusterRole is
  read-only (`pods`, `namespaces`, `pods/log`) — but that means Alloy's ServiceAccount token
  can read every pod's logs cluster-wide, which makes it a sensitive credential.
- **Grafana** (`grafana/grafana:12.4.13`) — query UI, Loki pre-provisioned as its datasource,
  admin credential in a gitignored Secret applied by hand. Not exposed — port-forward only,
  same rule as Argo CD.
- All run non-root, read-only rootfs, all capabilities dropped. Alloy's non-root UID
  (473) is upstream-documented as experimental; it works on this cluster (confirmed running).
- Verified live: Loki has logs from `argocd`, `gametorrent`, `kube-system`, `observability`.

**Metrics — added 2026-11-04, same namespace.** Logs say what an app
printed; metrics say how much and how it changed over time (which `kubectl top` and Loki can't).
- **Prometheus** (`v3.15.1`, digest-pinned) — scrapes the kubelet's `/metrics` (PVC usage) and
  `/metrics/cadvisor` (per-pod/container CPU, memory, network, plus node totals) and
  kube-state-metrics, every 30s. 15 days or 3GB retention, whichever hits first, on a 5Gi PVC.
  Admin and lifecycle APIs left off. Authenticates to the kubelet with its ServiceAccount token,
  whose ClusterRole is `nodes` get/list/watch + `nodes/metrics` get — deliberately NOT
  `nodes/proxy`, a much broader permission that reaches the kubelet's exec endpoints. The kubelet's
  cert is self-signed on k3s so scraping uses `insecure_skip_verify` — same accepted trade-off as
  metrics-server's `--kubelet-insecure-tls`.
- **kube-state-metrics** (`v2.20.0`, digest-pinned) — restarts, readiness, replica counts: what
  Kubernetes *believes*, which cAdvisor can't know. RBAC scoped to the 8 resource types the
  dashboard uses, no Secrets or ConfigMaps.
- **Not added: node-exporter.** It needs read access to the host's `/proc`, `/sys` and filesystem
  (hostPath/hostPID), which contradicts the hardening everything else follows. Node CPU/RAM still
  come from cAdvisor's root cgroup; host disk-free does not. Revisit only as a conscious exception.
- **Grafana** now has Loki *and* Prometheus as datasources (explicit uids) and one provisioned
  dashboard, `k8s/observability/dashboards/cluster-overview.json` — metrics and logs on one page,
  with a namespace dropdown and a log search box. Lives in git, so it survives a rebuild; the UI
  copy is read-only. Grafana's memory limit raised 384Mi -> 512Mi (it was at ~81% with no
  dashboards).
- **Isolation:** `networkpolicy.yaml` extended with only the named paths (Grafana -> Prometheus,
  Prometheus -> kube-state-metrics, Prometheus -> kubelet:10250 and API server via Cilium
  entities, kube-state-metrics -> API server).
- **Verified live, not just Running:** all 4 scrape targets UP; every one of the dashboard's 16
  panel queries returns data; both Grafana datasources report healthy; throwaway pods in
  `default` and `argocd` are blocked (8/8) from Prometheus, kube-state-metrics, Grafana and Loki.
  Testing the dashboard's own queries caught three real bugs before they reached a screen: a
  join on mismatched labels (empty "Node memory used"), an "All" value Loki rejects with HTTP 400
  (`.*` can match empty; `.+` can't), and a "Pods not Ready" panel that counted finished Helm
  jobs and would have shown 3 on a healthy cluster.
- **Cost:** Prometheus ~172Mi, kube-state-metrics ~13Mi, Grafana ~237Mi, Loki ~128Mi, Alloy ~100Mi
  (~650Mi for the whole namespace); node memory 50% -> 60%. Prometheus will grow with series
  count — its limit is 768Mi.
- **Not done — tracing**, the third APM signal ("which function in the app was slow"). Needs
  OpenTelemetry added to the webui's own code plus a backend (Tempo): an app-code change, not
  an infrastructure one. No alerting either — nothing routes a Prometheus/Grafana alert anywhere;
  Uptime Kuma is still what pings you.

**Image signing — `sign-image` job in `cicd/.gitlab-ci.yml`.** Written, dormant: skipped until
the owner generates a cosign keypair and adds `COSIGN_PRIVATE_KEY`/`COSIGN_PASSWORD` as
Protected CI/CD variables (TUTORIALS §2). Once active it signs `main` builds only (`dev` isn't
a protected branch). Nothing verifies signatures at deploy time yet — see the security-review
section.

**Hubble CLI** (`v1.20.2`, matching Hubble Relay) installed on the VM by hand on 2026-10-23
for `hubble observe`. Not in the Ansible role yet — a fresh provision won't have it.

## Phase 7 — PostgreSQL for the webui (2026-11-05)

**Why.** The 2026-11-04 audit found the JSON-file storage fragile (whole-file rewrites, no
transactions: a damaged `users.json` meant nobody could log in, and the next "create user"
overwrote every account), sessions only in memory, and no way to enforce anything about the
audit log. Accounts also needed real management (sign-up, disable, reset) that a flat file
made awkward.

**Shape.**
- `k8s/postgres/`: a StatefulSet with Postgres 17, deployed by the existing `gametorrent-webui`
  Argo CD app (`k8s/webui/kustomization.yaml` includes `../postgres`), so the app and its
  database always roll out together.
- Three roles: `postgres` (superuser, unused day to day), `gt_owner` (owns the schema, used only
  by the `db-migrate` initContainer), and `gt_app` (what the app connects as: data
  read/write, no DDL, audit log insert-only).
- NetworkPolicy: only the webui may connect to Postgres, and Postgres may connect to nothing.
- Schema: `webui/db/migrations/001_init.sql`. The full design and the reasoning per audit item
  are in `docs/WEBUI.md` ("Accounts", "Data storage", "Security").

**Cutover (what happens when `dev` is merged to `main`).**
1. Before merging: the three Secrets from `k8s/postgres/secret.example.yaml` are created on
   the VM with random values (generated there, never copied off it).
2. Argo CD syncs `gametorrent-webui`: Postgres starts and runs `init-roles.sql` on its empty
   volume. The new webui pod's `db-migrate` initContainer waits for it, applies migrations, and
   imports `webui/data/*.json` in one transaction. Then the app starts.
3. `network-policies` syncs the new webui → postgres allow rule. Until it does, the
   initContainer just keeps retrying.
4. Check that the import counts match the JSON files (users, requests, jobs), sign in, and check
   the Library still shows every game.

**Result (verified live, 2026-11-05).** Argo CD synced all five apps on the merge commit; `db-migrate`
logged `import: done. users=3 requests=4 jobs=1 feeds=0 providers=1 stats=0 audit=22` (matching the
JSON files exactly); the Jackett key is stored encrypted and search still works through it; `gt_app` can
only INSERT/SELECT on `audit_log`; Postgres runs as uid 70, read-only rootfs, all caps dropped, no
service-account token. End-to-end on the live app: admin sign-in, the 3 games, one full
sign-up -> pending (login refused) -> approve -> use -> disable (session dead at once) -> delete cycle,
path traversal 404 for admin and user alike. The nightly backup carries `gametorrent.pgdump`, and a
restore of it into a scratch database gave back the live counts. Two accounts (`<user-a>`, `<user-b>`) still
have the old hash format; it upgrades at their next sign-in.

**Rollback.** Re-point the image to the last pre-database build (`:<sha>` of `deac3c7`'s
pipeline) and remove `../postgres` from the kustomization. The JSON files were only ever
read, so the old app finds them exactly as they were. Anything created after the cutover
(new accounts, requests) exists only in the database; `pg_dump` from the nightly backup has it.

**Backups.** The nightly script now takes a `pg_dump` (via `kubectl exec`, verified with
`pg_restore --list`) into the same archive. It fails rather than skipping if it can't ask the
cluster. See `docs/DEBUG.md` §15/§16.

## Phase 8 — pins, Argo CD for observability, less privilege (2026-11-05)

Findings from the 2026-11-04 audit (#6, #7), done together because they touch the same manifests.

- **Every image pinned by digest.** Loki, Alloy, Grafana and both `busybox` initContainers were still
  `tag`-only; the digests are the ones the *running* pods already reported (`imageID`), so pinning
  changed nothing about what runs. Postgres, Kuma, Jackett, Prometheus, kube-state-metrics and
  metrics-server already were. The webui is pinned through a kustomize `images:` entry
  (`k8s/webui/kustomization.yaml`) that `cicd/scripts/pin-webui-image.js` maintains: the old
  floating `:main` tag was why a merged fix never reached the running pod. How releases work now:
  `docs/CI_CD.md` "Releasing". `cicd/tests/manifest-selftest.js` enforces all of it in CI.
  (k3s's own bundled images and Argo CD's upstream install manifests are outside this repo's control.)
- **Observability under Argo CD.** Application `observability` created in manual mode first, to see
  what Argo thought differed: every object showed OutOfSync, but only because none carried Argo's
  tracking label yet; `git diff` confirmed `main` matched what had been hand-applied. One manual sync
  adopted everything with no pod restarted, then automated sync + prune + self-heal was turned on
  like the other apps. The namespace and `grafana-secret` stay hand-managed on purpose (not in the
  kustomization), so Argo's prune can never delete either.
- **Uptime Kuma: uid 1000, every capability dropped.** The old manifest said Kuma "can't run
  non-root". The cause was the image's `extra/entrypoint.sh` (chowns `/app/data` to `PUID:PGID`, then
  drops privileges with `setpriv`, so it needs root), not Kuma's code. The manifest now runs
  `dumb-init -- node server/server.js` directly and a `fix-volume-ownership` initContainer (only
  `CHOWN`, `DAC_OVERRIDE`, `FOWNER`) fixes the existing data once. Tested first on a copy of the live
  data: serves, writes SQLite, ICMP ping works without `NET_RAW` (the pod's ping sysctl), and the
  only monitor is HTTP.
- **Jackett: three capabilities instead of a root container's default set.** Its s6 init must start
  as root. In the live pod the Jackett process was already uid 911 with *no* capabilities (the old
  `PUID: 1000` had never been applied; the read-only rootfs forbids the remap), so only the
  supervisor needed cutting down. Testing on a copy found the real minimum the hard way:
  `SETUID`+`SETGID` alone starts fine but every search fails (`Access to the path
  '/run/jackett-temp/' is denied`); adding `CHOWN` fixed it, same search results as production.
  Lesson recorded in the manifest: "it starts" is not "it works"; test a real request.
- **Not done, deliberately:** copying backups off the VM (the owner wants everything on the VM; the
  archives therefore protect against mistakes and corruption, not a dead disk or a lost VM).

## Phase 9 — the VM itself (2026-11-05)

Audit items #8 (VM open on the LAN) and #9 (Docker leftovers, pending reboot).

- **Firewall (ufw), `docker/host/usr/local/sbin/gametorrent-firewall.sh`.** Before, the VM had none:
  from the LAN, the Kubernetes API (6443), the kubelet (10250), Hubble's *unauthenticated* flow port
  (4244) and Cilium's health/metrics ports (4240, 9963, 9964) all answered. Measured from the admin PC
  before and after (`.scratch`-style port probe, 10 ports): now only SSH (22) and the three apps
  answer; the six internals are closed. Rules: SSH and the apps from the LAN (192.0.2.0/24) and from
  Tailscale; the API (6443) over Tailscale only; everything from the pod network (10.0.0.0/8) to the
  node, so Argo CD, Prometheus, Hubble Relay and the API proxy keep working; Tailscale's UDP 41641.
  Default deny incoming.
  - **What it cannot do:** ports 3000/3001/9117 are pod `hostPort`s, and Cilium (eBPF, kube-proxy
    replacement) hands those packets to the pod in the network driver *before* the kernel firewall sees
    them. The rules for them are belt and braces; the real controls on those ports are the apps' logins
    and the NetworkPolicies. Found by looking at which sockets actually listen: none do for those ports.
  - **How it was applied safely:** an automatic rollback (`systemd-run --on-active=420 ufw disable`) was
    armed first, new connections were tested from the PC (not the existing SSH session, which
    connection-tracking would have kept alive regardless), then the timer was cancelled. A pod opening
    *new* connections to the node's API/kubelet/Hubble ports, pod internet access, Argo CD's refresh,
    Prometheus scraping the kubelet, Loki ingest and a real search were all checked with the firewall on.
  - **Not testable from here:** inbound over Tailscale. This PC is not on the tailnet, so the
    `tailscale0` rules are straightforward but unexercised.
- **Docker retired, not uninstalled.** The three stopped migration containers and 6 GB of images were
  removed; `docker`, `docker.socket` and the system `containerd` are disabled (k3s has its own
  containerd and was unaffected). Ten anonymous volumes (~400 MB) leaked by my own test containers were
  deleted after checking they were created that day. The named volumes stay: `gametorrent-roms` has a
  file listing identical to the cluster's PVC, and the Oct-10 `pre-k3s-migration-*.tgz` archives cover
  roms/downloads/webui-data; a final archive of the small ones (webui-data, Jackett, Kuma, Komodo,
  ~14 MB) is `/var/backups/gametorrent/docker-volumes-final-2026-11-05.tgz` (root-only).
  Docker is still installed so tests can use it: `sudo systemctl start docker` (the helper scripts do
  this and stop it again).
- **Reboot** onto the kernel that had been waiting (7.0.0-38 -> 7.0.0-42): back in about 90 seconds on
  the same DHCP address, 28 pods ready after 50 s, every NetworkPolicy, Argo CD app and the database
  intact, firewall still enforced, Docker still off.

## Rollback now that Phase 4 is live

*(Changed 2026-11-05, Phase 9.)* The Docker containers are gone, so the old "scale the pod to 0 and
`docker start`" path no longer exists, and would not be a good rollback anyway: the Docker volumes hold
data from before 2026-10-10, not the live data. The real rollback is Argo CD: `git revert` the change and
merge. For data, the nightly archive `/var/backups/gametorrent/live-pvc-*.tgz` (root-only) holds the
database dump and the PVCs (`docker/host/README.md` has the restore commands); the pre-cutover archives
`pre-k3s-migration-*.tgz` and `docker-volumes-final-2026-11-05.tgz` are the last copies of the Docker-era
state. Rebuilding the Docker stack would mean `docker build` from the repo's `Dockerfile`s.

## What's new to security-review once this is live

Not covered by the existing `log/` notes (those are about the Docker deployment): the k3s API
server's own exposure/auth, and Argo CD's RBAC and the scope of its repo credentials.

**Fixed 2026-10-27:** ~~`observability` had no NetworkPolicy while Loki ran with
`auth_enabled: false`~~ (a pod in `argocd` could read every pod's logs or inject fake ones —
confirmed by test). `k8s/observability/networkpolicy.yaml`: default-deny, then only Alloy →
Loki, Grafana → Loki, DNS, and Alloy → the API server. The API-server rule is a
`CiliumNetworkPolicy` using the `kube-apiserver` entity, because the API server sits on the
node's DHCP-leased IP and an `ipBlock` would break on the next lease change. Verified live:
`argocd` and `default` pods blocked from Loki and Grafana (Hubble: `Policy denied DROPPED`),
Alloy still ships, Grafana's Loki datasource healthy, `port-forward` unaffected. Remaining
limit: node/`hostNetwork` traffic can still reach pods (Cilium's kubelet-probe default).

**Open gaps from Phase 6 (found in the 2026-10-26 audit, not fixed yet):**
- **Image signatures aren't enforced.** Once `sign-image` is active, signatures exist, but
  nothing rejects an unsigned image. Next step: an admission controller (Kyverno
  `verifyImages` or Sigstore `policy-controller`) checking against `cosign.pub`.
- **`sign-image` downloads the cosign binary with `curl` and no checksum check** — the one
  unverified download in a job whose purpose is supply-chain integrity. It also writes the
  private key to a file and deletes it only if signing succeeds. Fix: use the official
  pinned cosign image, and `--key env://COSIGN_PRIVATE_KEY` so the key never touches disk.
- **Loki, Alloy and Grafana images are pinned by tag, not digest** — every other image under
  `k8s/` is digest-pinned (log/M5), including the newer Prometheus and kube-state-metrics.
- **Alloy has no readiness/liveness probe**, and nothing alerts if Loki stops receiving logs —
  if the collector wedges, logs silently stop.
- ~~Grafana ran at ~81% of its 384Mi memory limit~~ — fixed 2026-11-04 (limit now 512Mi; ~237Mi in use).

~~The absence of any `NetworkPolicy`...~~ **Addressed, 2026-10-15** — see `k8s/network-policies/`.
Default-deny in `gametorrent`, explicit allows only for what's actually needed (DNS,
`webui → jackett`, `uptime-kuma → webui`, each app's own exposed port, and internet egress for
webui/Jackett specifically — scoped with an `ipBlock` `except` list covering every internal
range in this cluster: the pod network `10.0.0.0/8` /* Cilium's real IPAM pool, not k3s's
nominal `10.42.0.0/24` */, Service IPs `10.43.0.0/16`, the LAN `192.0.2.0/24`, Tailscale
`100.64.0.0/10`). `argocd` gets a narrower rule: nothing outside its own namespace can open an
ingress connection to any of its pods (the actual boundary against a compromised app pod
escalating into the GitOps controller that holds the GitLab credential) — deliberately not a
full default-deny-and-enumerate for argocd's own internal mesh, since getting one port wrong
there risks breaking Argo CD itself for a security property the narrower rule already delivers.

All three app Deployments also set `automountServiceAccountToken: false` — none of them call
the k8s API, so a full RCE on any one of them finds no token to steal for a vertical escalation
into the cluster API either.

Verified live, not just applied-and-assumed: external access to all three apps still works,
DNS resolves, `webui → jackett` still works, Jackett can still reach the real internet (its
whole purpose), and a test connection from `webui` to `argocd-server` genuinely times out/gets
refused post-change where it previously would have succeeded.

Hubble Relay is enabled (`cicd/ansible/roles/k3s/tasks/main.yml`) for flow visibility — it's
observability, not enforcement; the actual access control is the NetworkPolicy objects above.
ClusterMesh (Cilium's multi-cluster federation) is deliberately NOT enabled: this is one node,
one cluster, nothing to federate with.

## Known issue, fixed properly on the second attempt: `metrics-server` (`kubectl top`)

k3s's bundled `metrics-server` (`rancher/mirrored-metrics-server:v0.9.0`) panicked on every boot:

```
panic: runtime error: makeslice: len out of range
runtime/metrics.init.0()
```

First theory (CPU hot-add making the VM's "possible" CPU count 128 vs 6 actually online,
confirmed via `CPU topo: Allowing 6 present CPUs plus 122 hotplug CPUs` in `dmesg`) turned out
**wrong** — capping it with a `possible_cpus=6` GRUB parameter (kept, harmless, matches reality)
didn't fix it. The real cause, confirmed by extracting the binary and comparing Go build
versions: it's a bug specific to this exact release build (Go 1.26.4) — CoreDNS, built with an
even newer Go (1.26.6), runs fine on the same node, so it isn't a general toolchain/kernel
incompatibility. Confirmed the Rancher mirror and the official `registry.k8s.io` image are
byte-identical (same sha256) — not a mirroring issue either.

**First fix attempt (2026-10-14) — wrong, didn't survive a reboot.** Downgraded to `v0.8.1`
(Go 1.24.12, confirmed starting clean) by editing k3s's own bundled manifest file directly on
the VM (`/var/lib/rancher/k3s/server/manifests/metrics-server/metrics-server-deployment.yaml`),
and claimed in this doc that it "survives a k3s restart or VM reboot" — **that claim was never
actually tested and turned out false.** Confirmed for real (2026-10-21): after a routine
reboot, the file's mtime showed it had been rewritten and the image was back to the broken
`v0.9.0`, because k3s treats that whole directory as its own and re-syncs it from its embedded
defaults on every k3s restart, not just first install. A manual file edit there was never a
durable fix — it happened to survive until the next reboot that actually exercised the
resync, which took about a week to occur.

**Real fix (2026-10-21):** stopped relying on k3s's bundled copy at all.
`--disable=metrics-server` added to k3s's `INSTALL_K3S_EXEC`
(`cicd/ansible/roles/k3s/tasks/main.yml`, and applied live by editing
`/etc/systemd/system/k3s.service`'s `ExecStart` and `systemctl restart k3s` on the already-
running VM) stops k3s from shipping metrics-server as one of its own addons. `k8s/metrics-server/`
is our own replacement, pulled from upstream's official `components.yaml` for `v0.8.1` and pinned
by digest — version-controlled and Argo CD-managed exactly like webui/jackett/uptime-kuma, so it
can never again silently revert on a reboot. One addition over the stock upstream manifest:
`--kubelet-insecure-tls` (k3s's kubelet serving certs aren't CA-signed, so metrics-server
can't scrape any kubelet without it — this is k3s's own documented requirement, not a security
downgrade specific to this cluster). Verified: `kubectl top nodes` / `kubectl top pods` both
work.
