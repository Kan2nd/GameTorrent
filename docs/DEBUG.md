# Debugging & status reference

Two parts: **Part 1** is a checklist for "is everything okay right now" — one section per
layer, the exact command, and what a healthy result looks like. **Part 2** is a literal,
command-by-command replay of how the current k3s/Argo CD setup actually got built, since most
of it ran through an AI session and never touched a terminal you watched directly.

Everything here assumes you're SSH'd into the VM unless marked otherwise:
```bash
ssh <ssh-user>@<current-ip>   # see "0. Find the VM" below — the IP changes on reboot
export KUBECONFIG=$HOME/.kube/config   # needed every session; k3s's own kubectl defaults
                                        # to the root-only /etc/rancher/k3s/k3s.yaml otherwise
```

**If `kubectl` says `permission denied`** — this is the one you'll hit most:
```
level=warning msg="Unable to read /etc/rancher/k3s/k3s.yaml, please start server with --write-kubeconfig-mode ..."
error: error loading config file "/etc/rancher/k3s/k3s.yaml": open ...: permission denied
```
It isn't a cluster or RBAC problem. You skipped the `export` above, so `kubectl` fell back to the
root-only file (`-rw------- root root`). Your own copy, `~/.kube/config`, is fine. Fix it for
the current session by running the `export` line; fix it permanently (once, on the VM) with:
```bash
echo 'export KUBECONFIG=$HOME/.kube/config' >> ~/.bashrc && source ~/.bashrc
```
(Not `sudo kubectl` — that works but runs everything as root, which hides real permission
problems instead of fixing them.)

---

## Part 1 — Status checklist

### 0. Find the VM

`kan2server` is on VMware's NAT network with a normal DHCP lease — it keeps the same IP while
it stays up, but can get a new one after being powered off. From your Windows PC:
```bash
wsl -e /mnt/d/STUDY/Sem\ alone/Project\ GameTorrent/cicd/ansible/scripts/resolve-vm-ip.sh <vm-mac>
```
Prints the current IP, read straight from VMware's own DHCP lease file by the VM's MAC address
(which never changes). `credentials.md` also has the last-known IP, but this script is the
actual source of truth.

### 1. Is the VM even up?

```bash
ping -c 2 <ip>
ssh <ssh-user>@<ip> 'echo up'
```
No reply at all (not even "destination unreachable") usually means the VM is powered off or
asleep, not a network issue — check VMware directly.

### 2. Is the k3s cluster healthy?

```bash
kubectl get node
```
Want: `STATUS Ready`. If it says `NotReady`, check Cilium next — a node can't go Ready without
a working CNI.

### 3. Is Cilium (the CNI) healthy?

```bash
cilium status
```
Want: everything green (`OK`), including `Hubble Relay: OK`. If Cilium itself is down, every
pod's networking is affected, not just one app — this is a cluster-wide problem, check this
before suspecting an individual app.

```bash
cilium status --verbose   # more detail if something's red
```

### 4. What's actually running, everywhere?

```bash
kubectl get pods -A
```
Read `READY` (`1/1` is healthy; `0/1` means the container isn't passing its readiness probe)
and `STATUS` (`Running` good; `CrashLoopBackOff`, `ImagePullBackOff`, `Pending`, `Error` are
all problems, each meaning something different — see Part 2's "common failure states" below).

Scoped to just this app's namespace:
```bash
kubectl -n gametorrent get pods -o wide
```

### 5. Is Argo CD actually managing everything it should?

```bash
kubectl -n argocd get applications
```
Six rows expected: `gametorrent-webui`, `jackett`, `uptime-kuma`, `network-policies`,
`metrics-server`, `observability`. Two
columns matter:
- **SYNC STATUS**: `Synced` = the live cluster matches what's in git on `main`. `OutOfSync`
  means something drifted (someone `kubectl edit`'d something directly, or git has a change
  not yet applied). `Unknown` usually means it can't even reach the repo or render the
  manifests — check the detail next.
- **HEALTH STATUS**: `Healthy` = the actual resources (pods, etc.) are up and passing checks.
  `Degraded` = Argo CD sees the resources but they're broken (e.g. `ImagePullBackOff`).
  `Progressing` = mid-rollout, often resolves on its own in under a minute.

For *why* something isn't Synced/Healthy:
```bash
kubectl -n argocd get application <name> -o jsonpath="{.status.conditions}"
kubectl -n argocd describe application <name>
```
`ComparisonError: <path>: app path does not exist` specifically means `main` doesn't have that
folder yet — that's expected until `dev` is merged to `main` (your call, never done
automatically).

Force an immediate re-check instead of waiting for the ~3-minute poll:
```bash
kubectl -n argocd patch application <name> -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}' --type merge
```

### 6. Is each app actually serving traffic?

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/login.html   # webui
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9117/favicon.ico  # jackett
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3001/            # uptime-kuma
```
Want `200` (webui, jackett) or `302` (kuma — redirects to its dashboard, that's normal). This
checks the real external path (`hostPort`), the same way a browser on the LAN would reach it —
not just "is the pod Running", which can be true even if something's still broken.

### 7. Resource usage (CPU/RAM) — per pod and per node

```bash
kubectl top nodes
kubectl top pods -A
```
Needs `metrics-server` to be healthy first (`kubectl -n kube-system get pods -l
k8s-app=metrics-server` — want `1/1 Running`; see Part 2 for the whole saga if it isn't).

### 8. NetworkPolicy — what's actually enforced right now

```bash
kubectl -n gametorrent get networkpolicy
kubectl -n argocd get networkpolicy
```
Lists every policy object by name. To see exactly what one does:
```bash
kubectl -n gametorrent describe networkpolicy <name>
```
To test whether a specific path is actually blocked or allowed (replace the target):
```bash
kubectl -n gametorrent exec deploy/gametorrent-webui -c gametorrent-webui -- \
  node -e 'require("http").get({host:"argocd-server.argocd.svc.cluster.local",port:80,timeout:4000}, r=>console.log(r.statusCode)).on("error",e=>console.log("blocked:",e.message)).on("timeout",function(){console.log("blocked: timeout");this.destroy()})'
```

### 9. Logs for a specific app

```bash
kubectl -n gametorrent logs deploy/gametorrent-webui --tail=50
kubectl -n gametorrent logs deploy/gametorrent-webui --tail=50 --previous   # the crashed instance, if it restarted
kubectl -n gametorrent logs deploy/gametorrent-webui -c fix-volume-ownership   # the init container specifically
```

### 10. CI pipeline / registry — did the last push actually build an image?

```bash
TOKEN=$(cat "D:\STUDY\Sem alone\gitlantoken.md" | tr -d '\n')
curl -s --header "PRIVATE-TOKEN: $TOKEN" \
  "https://gitlab.com/api/v4/projects/kannguyen3105%2Fgametorrent/pipelines?ref=main&per_page=3" \
  | python -c "import json,sys; [print(p['id'],p['status'],p['sha'][:8],p['created_at']) for p in json.load(sys.stdin)]"
```
**Important:** a pipeline's overall `status` can say `manual` even when everything that matters
passed — `deploy:tauri-placeholder` is an intentionally-never-triggered unrelated job that
makes GitLab report the whole pipeline as `manual` once it's the only thing left pending.
Always check the actual jobs, not just the summary status:
```bash
curl -s --header "PRIVATE-TOKEN: $TOKEN" \
  "https://gitlab.com/api/v4/projects/kannguyen3105%2Fgametorrent/pipelines/<id>/jobs" \
  | python -c "import json,sys; [print(j['name'],j['status'],j['stage']) for j in json.load(sys.stdin)]"
```
What actually matters for a deploy: `trivy-fs`, `build-image`, `trivy-image`, `push-image` all
`success`.

Does the image tag the Deployment wants actually exist?
```bash
curl -s --header "PRIVATE-TOKEN: $TOKEN" \
  "https://gitlab.com/api/v4/projects/kannguyen3105%2Fgametorrent/registry/repositories/12578448/tags/main" \
  | python -m json.tool
```
Check `created_at` lines up with a recent pipeline, not some old leftover.

### 11. git state — is `dev`/`main` actually what you think?

```bash
git fetch origin
git log --oneline origin/dev -5
git log --oneline origin/main -5
git merge-base --is-ancestor origin/dev origin/main && echo "main has everything dev does" || echo "main is BEHIND dev"
```
Don't trust local branch pointers without fetching first — a local `main`/`dev` can silently
diverge from the remote if a commit landed on the wrong branch and was never pushed (this
happened for real during this project — see Part 2's note on it).

### 12. Reach the Argo CD UI yourself

Not exposed anywhere — reachable only via a double SSH tunnel:
```bash
# 1. On your PC, check nothing's already using the local port you're about to pick
#    (something called AgentService grabbed 8080 once during this project — pick a free one)
ssh -L 8081:localhost:8080 <ssh-user>@<ip>
# 2. In THAT SAME ssh session, on the VM:
export KUBECONFIG=$HOME/.kube/config
kubectl -n argocd port-forward svc/argocd-server 8080:443
# 3. Browse https://localhost:8081 on your PC (self-signed cert warning is expected)
```
Password: see `credentials.md`, or fetch it fresh (it can get regenerated if argocd-server is
ever recreated):
```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

### 13. Is logging and metrics working? (Loki / Alloy / Prometheus / Grafana)

```bash
kubectl -n observability get pods   # want loki, alloy, prometheus, kube-state-metrics, grafana all 1/1 Running
```
"Pods are Running" isn't the same as "logs are flowing". Ask Loki which namespaces it has logs
for (Loki's image has no shell, so query it from the VM, not via `kubectl exec`):
```bash
kubectl -n observability port-forward svc/loki 3100:3100 &
curl -s http://localhost:3100/loki/api/v1/label/namespace/values
```
Healthy: `"argocd"`, `"gametorrent"`, `"kube-system"`, `"observability"` in the list. If a
namespace is missing, check the collector next:
```bash
kubectl -n observability logs deploy/alloy --tail=30   # look for errors, not just "tailer exited"
```
("container terminated, stopping tailer" lines are normal — that's init containers finishing.)

Grafana UI (port-forward only, never exposed — don't use 3001, Uptime Kuma owns it):
```bash
ssh -L 3002:localhost:3002 <ssh-user>@<ip>                         # on your PC
kubectl -n observability port-forward svc/grafana 3002:3000   # in that same session, on the VM
```
Browse `http://localhost:3002` → **Explore** → Loki → `{namespace="gametorrent"}`. Login is in
`k8s/observability/grafana-secret.yaml` (gitignored) or:
```bash
kubectl -n observability get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d
```

**Metrics:** same lesson as logs — Running isn't the same as scraping. Ask Prometheus whether its
targets are actually up:
```bash
kubectl -n observability port-forward svc/prometheus 9099:9090 &
curl -s localhost:9099/api/v1/targets | python3 -c "import json,sys; [print(t['labels']['job'], t['health'], t.get('lastError','')) for t in json.load(sys.stdin)['data']['activeTargets']]"
```
Healthy: `cadvisor`, `kubelet`, `kube-state-metrics`, `prometheus` all `up`. A `down` target
shows its error. The usual suspects: `context deadline exceeded` on the kubelet jobs = a
NetworkPolicy dropped the path to the node (check `prometheus-to-kubelet` in
`k8s/observability/networkpolicy.yaml`); `401/403` = the ServiceAccount lost `nodes/metrics`.
Quick data check (should return a number per pod):
```bash
curl -s -G localhost:9099/api/v1/query --data-urlencode 'query=count(container_memory_working_set_bytes{container!=""})'
```
Grafana datasource health (both should say OK) — in the UI: **Connections → Data sources →
Prometheus/Loki → Save & test**, or via the API with the admin password.

### 14. Network flows — who's talking to whom (Hubble)

Hubble shows **network traffic**, not application output: every connection Cilium sees, with
the NetworkPolicy verdict. Use it when "X can't reach Y" — `kubectl logs` can't tell you that.
```bash
kubectl -n kube-system port-forward svc/hubble-relay 4245:80 &
hubble observe --server localhost:4245 --namespace gametorrent --last 20   # recent traffic
hubble observe --server localhost:4245 --verdict DROPPED --last 20         # what policy blocked
hubble observe --server localhost:4245 --follow                            # live
```
A real blocked line looks like:
`gametorrent-webui-... <> argocd/argocd-server-...:8080 Policy denied DROPPED`.
The `hubble` CLI is installed on the VM by hand (`v1.20.2`), not by Ansible — see Part 2 Phase J.

### 14b. Is what's running the image git says should run?

The webui is pinned by digest in git, so "Synced" can be checked down to the byte:
```bash
# the digest git asks for ...
grep -A1 pinned-from k8s/webui/kustomization.yaml
# ... and the one actually running (both containers should show the same one)
kubectl -n gametorrent get pod -l app=gametorrent-webui \
  -o jsonpath='{range .items[0].status.containerStatuses[*]}{.imageID}{"\n"}{end}{range .items[0].status.initContainerStatuses[*]}{.name} {.imageID}{"\n"}{end}'
# every image in the cluster that is NOT pinned by digest (k3s/Argo's own are expected; ours should not appear)
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{" "}{range .spec.containers[*]}{.image}{" "}{end}{"\n"}{end}' | grep -v "@sha256" | grep -E "^(gametorrent|observability)" || echo "none of ours"
# privileges of the two root-start apps
kubectl -n gametorrent get pod -l app=uptime-kuma -o jsonpath='{.items[0].spec.securityContext.runAsUser}{" "}{.items[0].spec.containers[0].securityContext.capabilities.drop}{"\n"}'
kubectl -n gametorrent get pod -l app=jackett -o jsonpath='{.items[0].spec.containers[0].securityContext.capabilities}{"\n"}'
```
If the first two disagree after a merge, the pin hasn't been bumped yet (`docs/CI_CD.md` "Releasing").

### 14c. Is the host firewall doing what it should?

```bash
sudo ufw status verbose                      # Status: active; Default: deny (incoming), allow (outgoing), deny (routed)
systemctl is-enabled ufw                     # enabled (it must survive a reboot)
sudo ss -tlnp | awk 'NR>1{print $4, $6}' | sort -u   # what is LISTENING (the ports ufw can actually filter)
```
From **another machine on the LAN** (the admin PC), what really answers? This is the check that matters,
because it is what an attacker would see:
```bash
for p in 22 3000 3001 9117 6443 10250 4244 4240 9963 9964; do
  timeout 3 bash -c "exec 3<>/dev/tcp/<vm-ip>/$p" 2>/dev/null && echo "$p open" || echo "$p closed"; done
```
Expected: `22 3000 3001 9117` open, the other six closed. A firewall that was never measured is a guess:
the pre-firewall run of this exact loop showed all ten open.

Remember what ufw can't see: 3000/3001/9117 are Cilium hostPorts, handled in the network driver before the
kernel firewall; a `ufw deny 3000` would do nothing. Control those with the apps' logins and NetworkPolicies.
If the cluster misbehaves right after a firewall change, the first suspect is the "pods to node" rule
(`ufw status | grep 10.0.0.0/8`): pods reach the API server, kubelet and Cilium agent on the node's IP.

### 15. Are the backups actually backing up the *live* data?

A nightly systemd timer (03:30 UTC) takes a `pg_dump` of the webui database
(`gametorrent.pgdump`) and tars it with three small state PVCs (`webui-data`, `jackett-config`,
`uptime-kuma-data`) into `/var/backups/gametorrent/live-pvc-<date>.tgz`, keeping the newest 7.
Script and restore recipe: `docker/host/README.md`.
```bash
systemctl list-timers gametorrent-backup.timer --no-pager      # when it last ran / runs next
journalctl -t gametorrent-backup -n 5 --no-pager -o cat        # "ok: ..." or "FAILED: ..."
sudo ls -l /var/backups/gametorrent/ | grep live-pvc           # one per night, sizes should drift
# does the newest archive contain *today's* data? (audit.log changes on every login)
sudo tar tzvf "$(sudo sh -c 'ls -1t /var/backups/gametorrent/live-pvc-2*.tgz | head -1')" | grep -E 'gametorrent.pgdump|audit.log|users.json'
```
Since the database cutover the live data is in `gametorrent.pgdump`, not the JSON files (those
stay frozen as a rollback copy). Its size should drift night to night; the JSON files' shouldn't.
Red flag: every archive the **exact same size** for days. That's how the 2026-10-10 → 11-04 gap
was found (Part 2 Phase N). "The timer ran OK" only proves it ran, not that it read the right thing.

### 16. Is the database healthy, and is the app really using it?

```bash
kubectl -n gametorrent get pods -l app=postgres                       # postgres-0 1/1 Running
kubectl -n gametorrent logs deploy/gametorrent-webui -c db-migrate     # "applying ...", "import: done ...", "migrate: ok"
kubectl -n gametorrent exec postgres-0 -- psql -U postgres -d gametorrent -c \
  "select (select count(*) from users) users, (select count(*) from game_requests) requests,
          (select count(*) from sessions where expires_at > now()) live_sessions,
          (select count(*) from audit_log) audit_rows"
kubectl -n gametorrent exec postgres-0 -- psql -U postgres -d gametorrent -c "select * from schema_migrations"
# who can do what (expect gt_app: no UPDATE/DELETE on audit_log)
kubectl -n gametorrent exec postgres-0 -- psql -U postgres -d gametorrent -c "\dp audit_log"
# recent audit entries, newest first
kubectl -n gametorrent exec postgres-0 -- psql -U postgres -d gametorrent -c \
  "select at, actor, ip, action, details from audit_log order by at desc limit 15"
# sign-ups waiting for an admin
kubectl -n gametorrent exec postgres-0 -- psql -U postgres -d gametorrent -c "select username, created_at from users where status = 'pending'"
```
`kubectl exec` goes around NetworkPolicy (it's the API server talking to the kubelet), so this
works even though nothing else in the cluster may reach Postgres. Local socket logins as
`postgres` are trusted inside the pod; over the network every role needs its password (SCRAM).

If the webui pod is stuck in `Init:0/2` or `Init:1/2`: `kubectl -n gametorrent logs
deploy/gametorrent-webui -c db-migrate`. "waiting for database" means Postgres isn't up yet, or
the webui -> postgres NetworkPolicy hasn't synced; "import failed, nothing was imported" names
the JSON file that broke it.

### Which tool answers which question

| Question | Tool |
|---|---|
| Why did this app crash / what did it print? | `kubectl logs` (now) or Grafana/Loki (history, search across pods) |
| Why can't pod A reach pod B? | Hubble (`--verdict DROPPED`) |
| Is something using too much CPU/RAM *right now*? | `kubectl top` (metrics-server) |
| How did CPU/RAM/restarts change over the last hours or days? | Grafana → "Cluster overview" dashboard (Prometheus) |
| Is the deployed state what git says? | Argo CD (`kubectl -n argocd get applications`) |
| Is the site up from the outside? | Uptime Kuma, or `curl` from §6 |
| Is the app's database OK / who signed up / what did the audit log record? | §16 |
| What can an attacker on my LAN actually reach? | §14c (run the port loop from another machine) |
| Would I get today's data back if the disk died tonight? | §15 (backups) — and no, not if the *disk* dies: they're on the same disk |

---

## Part 2 — How this was actually built, command by command

This replays the real sequence, grouped by phase. Reasoning/tradeoffs for each decision live in
`docs/K8S_MIGRATION.md` — this section is the mechanical "what commands ran," not the "why."

### Phase A — Install k3s + Cilium (replacing flannel)

Run via `cicd/ansible/k3s-playbook.yml` (idempotent — safe to re-run), but the commands it
executes on the VM are:
```bash
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION="v1.37.1+k3s1" \
  INSTALL_K3S_EXEC="--flannel-backend=none --disable-network-policy --kubelet-arg=pod-max-pids=256" \
  sh -
```
`--flannel-backend=none`: don't install k3s's default CNI at all (flannel's Linux bridge had a
real bug on this VM — its bridge never got a gateway IP, silently breaking pod networking for
22 hours before anyone noticed). `--disable-network-policy`: turn off k3s's flannel-oriented
policy controller since Cilium brings its own.

```bash
curl -sfL -o /tmp/cilium-cli.tar.gz \
  "https://github.com/cilium/cilium-cli/releases/download/v0.20.1/cilium-linux-amd64.tar.gz"
tar -C /usr/local/bin -xzf /tmp/cilium-cli.tar.gz cilium
cilium install --version v1.20.2 --kubeconfig ~/.kube/config
cilium status --wait --wait-duration=180s --kubeconfig ~/.kube/config
```
This is what actually brings up pod networking — the node can't go `Ready` until this
completes (confirmed in testing: it correctly reports `NotReady`/`NetworkPluginNotReady` in the
gap between k3s installing and Cilium finishing).

```bash
kubectl create namespace argocd --dry-run=client -o yaml | kubectl apply -f -
kubectl apply --server-side --force-conflicts -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.4/manifests/install.yaml
kubectl -n argocd rollout status deployment/argocd-server --timeout=180s
```
`--server-side`, not plain `apply`: one CRD in that manifest
(`applicationsets.argoproj.io`) embeds an OpenAPI schema too large for the
`kubectl.kubernetes.io/last-applied-configuration` annotation client-side apply tries to write
(hit this for real — plain `apply` failed outright). Server-side apply doesn't use that
annotation.

```bash
kubectl create namespace gametorrent --dry-run=client -o yaml | kubectl apply -f -
```

### Phase B — CI builds and pushes the webui image

Added a `registry` stage to `cicd/.gitlab-ci.yml` (`push-image` job) — no new command to run by
hand, this runs automatically on every push to `dev`/`main`. What it does, functionally:
```bash
# (inside the CI job, using the artifact build-image already produced — never rebuilds)
docker tag "$IMAGE_NAME:$IMAGE_TAG" "$CI_REGISTRY_IMAGE/webui:$CI_COMMIT_SHORT_SHA"
docker push "$CI_REGISTRY_IMAGE/webui:$CI_COMMIT_SHORT_SHA"
docker tag "$IMAGE_NAME:$IMAGE_TAG" "$CI_REGISTRY_IMAGE/webui:$CI_COMMIT_REF_SLUG"   # :main or :dev
docker push "$CI_REGISTRY_IMAGE/webui:$CI_COMMIT_REF_SLUG"
```

### Phase C — Cut `gametorrent-webui` over from Docker to k3s

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/webui/secret.yaml           # applied by hand once — gitignored, Argo CD never manages this
kubectl apply -k k8s/webui/                      # PVCs, Deployment, Service — boot-tested on EMPTY PVCs first
```
Then the actual data migration, once the empty-PVC boot test passed:
```bash
# stop (not remove) the old Docker container
docker stop gametorrent-webui

# find where each PVC actually lives on disk
PV=$(kubectl -n gametorrent get pvc webui-data -o jsonpath="{.spec.volumeName}")
PVPATH="/var/lib/rancher/k3s/storage/${PV}_gametorrent_webui-data"

# backup, then copy the Docker volume's data into the PV
docker run --rm -v gametorrent-webui-data:/d:ro -v /var/backups/gametorrent:/b busybox:1.36 \
  tar czf /b/webui-data-$(date +%F).tgz -C /d .
docker run --rm -v gametorrent-webui-data:/src:ro -v "$PVPATH":/dst busybox:1.36 sh -c "cp -a /src/. /dst/"

# verify file-for-file identical (name + sha256, not just size) before trusting it
docker run --rm -v gametorrent-webui-data:/d:ro busybox:1.36 find /d -type f -exec sha256sum {} +
sudo find "$PVPATH" -type f -exec sha256sum {} \;
# (repeated for webui-downloads and webui-roms too)

kubectl -n gametorrent delete pod -l app=gametorrent-webui   # recreate so hostPort actually binds
                                                               # (it silently no-ops while Docker still holds the port)
```

### Phase D — Dynamic IP resolution for Ansible

The VM's DHCP IP changing (`.145` → `.151`) kept breaking SSH/Ansible access. Fix:
`cicd/ansible/scripts/resolve-vm-ip.sh` reads the IP straight from VMware's own lease file
(`/mnt/c/ProgramData/VMware/vmnetdhcp.leases` from WSL) by the VM's MAC address, wired into
Ansible via `cicd/ansible/inventory/host_vars/kan2server.yml` (host_vars has to live *next to*
`hosts.ini`, not next to the playbooks — confirmed by testing, Ansible won't find it otherwise).
No manual command needed going forward — this just runs automatically whenever Ansible (or the
script directly) is used.

### Phase E — Retire Komodo's webhook path, then Komodo itself

```bash
# delete the GitLab webhook (via API, using the account-wide token)
curl -X DELETE --header "PRIVATE-TOKEN: $TOKEN" \
  "https://gitlab.com/api/v4/projects/kannguyen3105%2Fgametorrent/hooks/<webhook-id>"

# stop and disable the Cloudflare tunnel + its watchdog
sudo systemctl stop cloudflared-komodo-tunnel cloudflared-watchdog.timer
sudo systemctl disable cloudflared-komodo-tunnel cloudflared-watchdog.timer
sudo rm -f /etc/systemd/system/cloudflared-komodo-tunnel.service \
           /etc/systemd/system/cloudflared-watchdog.{service,timer} \
           /usr/local/bin/cloudflared-watchdog.sh
sudo systemctl daemon-reload

# apply the Argo CD Application for webui
kubectl apply -f k8s/argocd/application.yaml
```
Later, once Jackett and Kuma also moved to k3s and nothing was left for Komodo to deploy:
```bash
cd /etc/komodo
docker compose -p komodo -f compose.yaml --env-file compose.env down   # containers removed, volumes kept
```

### Phase F — Migrate Jackett and Uptime Kuma

Same pattern as Phase C (boot-test on empty PVCs → stop Docker container → backup → copy data →
sha256-verify → recreate pod), plus two real runtime problems found by testing, not guessed:

- **Jackett's `s6-overlay` init needs root** to drop to `PUID`/`PGID` itself — forcing
  `runAsNonRoot` crashed it immediately. Fixed by running it root (matching what Docker already
  did), keeping `readOnlyRootFilesystem: true` via `/run` and `/tmp` tmpfs mounts (these two
  concerns — root vs. read-only — are independent; conflating them was a mistake made and then
  corrected during this work, see the git history on `k8s/jackett/deployment.yaml`).
- **Jackett's readiness probe hit `/UI/Login`**, a stateful "TestCookie" redirect that
  intermittently 400'd under kubelet's real probe pattern (confirmed via `tcpdump` — never once
  reproduced with manual `curl`). Switched both probes to `/favicon.ico`, a static file.

```bash
kubectl apply -k k8s/jackett/
kubectl apply -k k8s/uptime-kuma/
kubectl apply -f k8s/argocd/application-jackett.yaml
kubectl apply -f k8s/argocd/application-uptime-kuma.yaml
```

### Phase G — metrics-server (`kubectl top`) was broken, root-caused, fixed

Was crash-looping since before this migration (4+ days, 80+ restarts) with:
```
panic: runtime error: makeslice: len out of range
runtime/metrics.init.0()
```
Root-caused by extracting the binary and comparing Go build versions (not guessed):
```bash
CID=$(docker create rancher/mirrored-metrics-server:v0.9.0)
docker cp "$CID":/metrics-server /tmp/ms-binary
strings /tmp/ms-binary | grep -E '^go1\.[0-9]+\.[0-9]+$'   # -> go1.26.4
```
Compared against CoreDNS (built with an even newer `go1.26.6`, runs fine) to rule out a general
Go/kernel incompatibility, and confirmed the Rancher-mirrored image is byte-identical
(`sha256sum`) to the official `registry.k8s.io` one, ruling out a bad mirror. That left only
"this specific release build is broken" — confirmed by testing the previous release:
```bash
docker run --rm --entrypoint /metrics-server registry.k8s.io/metrics-server/metrics-server:v0.8.1 --version
# -> prints "v0.8.1" cleanly instead of panicking
```
**First attempt — edited k3s's own bundled manifest directly:**
```bash
sudo sed -i 's|rancher/mirrored-metrics-server:v0.9.0|registry.k8s.io/metrics-server/metrics-server:v0.8.1|' \
  /var/lib/rancher/k3s/server/manifests/metrics-server/metrics-server-deployment.yaml
```
k3s's own "deploy" controller picks up a file change like this within seconds — no `kubectl
apply` needed. **This turned out not to be durable.** A week later, after a routine reboot, the
pod was back to `v0.9.0` and crash-looping again — k3s re-syncs that entire directory from its
own embedded defaults on every k3s restart, not just first install, silently reverting a
direct file edit. Caught by comparing the file's mtime against the VM's `uptime -p` (Part 1
§1) — the manifest had been rewritten minutes after the VM came back up.

**Real fix — stop relying on k3s's bundled copy entirely:**
```bash
# 1. Tell k3s not to ship its own metrics-server at all
sudo cp /etc/systemd/system/k3s.service /etc/systemd/system/k3s.service.bak-$(date +%Y%m%d)
# (add '--disable=metrics-server' \ to the ExecStart block, then:)
sudo systemctl daemon-reload
sudo systemctl restart k3s

# 2. Deploy our OWN copy — pulled from upstream's official components.yaml for v0.8.1,
#    pinned by digest, version-controlled, Argo CD-managed like everything else
kubectl apply -k k8s/metrics-server/
kubectl apply -f k8s/argocd/application-metrics-server.yaml
```
This is now exactly as durable as webui/jackett/uptime-kuma — a reboot can't silently revert
it because nothing on the VM owns that image tag anymore except git.

(A separate first theory for the ROOT CAUSE — not the durability issue above — CPU hot-add
making `/sys/devices/system/cpu/possible` report 128 vs. 6 actually online, turned out
**wrong** too, tested and disproven via a `possible_cpus=6` GRUB parameter + reboot that didn't
fix the panic. Left the GRUB change in place anyway since it's harmless and makes the kernel's
own CPU reporting match reality, but it gets no credit for the actual fix either.)

### Phase H — NetworkPolicy hardening + Hubble Relay

```bash
kubectl apply -k k8s/network-policies/
kubectl apply -f k8s/argocd/application-network-policies.yaml   # this one got missed on the first pass — see below
cilium hubble enable --kubeconfig ~/.kube/config
```
Verified live afterward, not just applied-and-assumed: external access to all three apps still
worked, DNS resolved, `webui → jackett` still worked, Jackett could still reach the real
internet, and a test connection from `webui` to `argocd-server` genuinely timed out
post-change where it previously succeeded (see Part 1 §8 for the exact test command).

### Phase I — Kuma's stale monitor

```bash
kubectl -n gametorrent exec deploy/uptime-kuma -- sqlite3 /app/data/kuma.db \
  "UPDATE monitor SET url = 'http://gametorrent-webui.gametorrent.svc:3000/login.html' WHERE id = 1;"
kubectl -n gametorrent delete pod -l app=uptime-kuma   # Kuma caches monitor config in memory on boot
```
Verified via the heartbeat table directly, not just "no error in the logs":
```bash
kubectl -n gametorrent exec deploy/uptime-kuma -- sqlite3 /app/data/kuma.db \
  "SELECT time, status, msg FROM heartbeat WHERE monitor_id = 1 ORDER BY time DESC LIMIT 5;"
```

---

### Phase J — Hubble CLI (by hand, 2026-10-23)

Hubble Relay was already running (Phase H); this added the client to query it:
```bash
curl -sfL -o /tmp/hubble-cli.tar.gz \
  "https://github.com/cilium/hubble/releases/download/v1.20.2/hubble-linux-amd64.tar.gz"
sudo tar -C /usr/local/bin -xzf /tmp/hubble-cli.tar.gz hubble
hubble version   # v1.20.2 — matches the relay
```
Not in `cicd/ansible/roles/k3s/` yet, so a fresh provision won't have it. No Hubble UI
installed — CLI only (`cilium hubble enable --ui` would add the web UI).

### Phase K — Logging: Loki + Alloy + Grafana (by hand, following TUTORIALS.md §1)

```bash
cp k8s/observability/grafana-secret.example.yaml k8s/observability/grafana-secret.yaml   # set a real password
scp -r k8s/observability <ssh-user>@<ip>:/tmp/observability
kubectl apply -f /tmp/observability/namespace.yaml        # by hand, never Argo CD-managed
kubectl apply -f /tmp/observability/grafana-secret.yaml   # by hand, gitignored
kubectl apply -k /tmp/observability/                      # loki, alloy, grafana
```
Two tutorial bugs found while doing this, both fixed in `TUTORIALS.md`: Loki's image has no
shell (so `kubectl exec ... wget` failed — query it via port-forward instead), and port 3001 was
first suggested for Grafana's port-forward even though Uptime Kuma already uses it (now 3002).

Added afterwards (2026-10-27), also applied by hand:
```bash
kubectl apply -f k8s/observability/networkpolicy.yaml   # default-deny + Alloy/Grafana -> Loki only
kubectl -n observability rollout restart deployment/alloy   # fresh connections under the new policy
```
Verified with throwaway pods in other namespaces (`kubectl run ... --rm -- nc -z -w 3 loki... 3100`
→ blocked) and Grafana's datasource health API (→ OK), not just "pods are still Running" —
Alloy has no probe, so Ready says nothing about whether it still reaches the API server.

Still to do: `kubectl apply -f k8s/argocd/application-observability.yaml` once `main` contains
`k8s/observability/` — until then it's not GitOps-managed.

### Phase L — cosign signing job (written, dormant)

`sign-image` in `cicd/.gitlab-ci.yml`. No command has been run for it yet — it waits for the
owner to generate a keypair (`cosign generate-key-pair`, deliberately not automated) and add
`COSIGN_PRIVATE_KEY` + `COSIGN_PASSWORD` as Protected CI/CD variables. Check whether it's armed:
```bash
curl -s --header "PRIVATE-TOKEN: $TOKEN" \
  "https://gitlab.com/api/v4/projects/kannguyen3105%2Fgametorrent/variables" \
  | python -c "import json,sys; print([v['key'] for v in json.load(sys.stdin)])"
```
Empty list = dormant. After it's active, verify a build: `cosign verify --key cosign.pub
registry.gitlab.com/kannguyen3105/gametorrent/webui:<short-sha>`.

### Phase M — Metrics: Prometheus + kube-state-metrics (by hand, 2026-11-04)

Same by-hand pattern as Phase K, in the same `observability` namespace. The whole folder is
applied as one kustomization, so the dashboard JSON becomes a ConfigMap automatically:
```bash
scp -r k8s/observability <ssh-user>@<ip>:/tmp/obs2        # (exclude grafana-secret.yaml; it's already applied)
kubectl apply -k /tmp/obs2/k8s/observability --dry-run=server   # validate everything first; nothing changes
kubectl apply -k /tmp/obs2/k8s/observability
kubectl -n observability rollout restart deployment/grafana   # re-reads datasources + dashboards
```
Image digests were pinned by pulling the tag locally and reading `RepoDigests`, then verified
against the manifests by script (hand-copied digests are easy to mistype):
```bash
docker pull quay.io/prometheus/prometheus:v3.15.1
docker image inspect quay.io/prometheus/prometheus:v3.15.1 --format '{{index .RepoDigests 0}}'
```
Verification that caught real bugs — run every dashboard panel's query against the real backends
(not just "the pod is Running"). It found a mismatched-label join (empty panel), an "All" value
Loki rejects with HTTP 400, and a "Pods not Ready" panel counting finished Helm jobs. The
dashboard JSON and `kustomization.yaml` explain the fixes; the lesson is the method: **a
dashboard you haven't queried is a guess.**

### Phase N — Backups pointed at the live PVCs (2026-11-04)

The nightly backup still tarred the Docker volume `gametorrent-webui-data`, which stopped being
live at the 2026-10-10 cutover. Every archive since was the identical stale snapshot (exactly
160,285 bytes each night), so requests, download history and the audit log written after the
cutover weren't in any backup. Found by comparing file dates inside the newest archive with the
live PVC (`requests.json` Oct 24 live vs. Oct 8 in the backup).

k3s's local-path provisioner stores each PVC as a plain directory on the node, named
`pvc-<uid>_<namespace>_<claim>`, so the host script can read it directly without `kubectl`:
```bash
sudo ls /var/lib/rancher/k3s/storage/                 # one dir per PVC
sudo cp -p /usr/local/bin/gametorrent-backup.sh{,.docker-era.bak}   # keep the old one
sudo install -m 750 docker/host/usr/local/bin/gametorrent-backup.sh /usr/local/bin/
sudo install -m 644 docker/host/etc/systemd/system/gametorrent-backup.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start gametorrent-backup.service       # run it once now, through systemd
journalctl -t gametorrent-backup -n 1 -o cat          # ok: .../live-pvc-2026-11-04-1603.tgz (279665 bytes)
```
The script matches on `_<namespace>_<claim>` instead of a hard-coded uid, so it survives a
recreated PVC. It fails loudly instead of archiving nothing: it requires exactly one directory
per claim and checks that the key files are inside the archive. The old Docker-era
`webui-data-*.tgz` archives are left in place (no longer rotated) as the only pre-cutover copies.

### Phase O — PostgreSQL cutover for the webui (2026-11-05)

Design and reasoning: `docs/K8S_MIGRATION.md` Phase 7 and `docs/WEBUI.md`. What was actually run, in
order (everything on the VM, nothing copied off it):

```bash
# 1. random passwords + encryption key, generated ON the VM and fed to kubectl on stdin (never in git,
#    never printed); a root-only copy is kept at /var/backups/gametorrent/db-secrets.env
ssh <ssh-user>@<ip> 'sh ~/make-db-secrets.sh && rm ~/make-db-secrets.sh'
# 2. merge dev -> main; Argo CD does the rest. Watch it:
kubectl -n argocd get applications                                  # gametorrent-webui Synced/Healthy on the merge commit
kubectl -n gametorrent get pods                                     # postgres-0 1/1, new webui pod 1/1
kubectl -n gametorrent logs deploy/gametorrent-webui -c db-migrate  # applying 001_init.sql / import: done / migrate: ok
# 3. verify against the old JSON counts, then through the app (Part 1 section 16)
```
Before merging, the import was rehearsed against a copy of the live `webui-data` in throwaway
containers on the VM (counts only printed, copy deleted afterwards), and the whole API test suite
(70 checks) was run against a throwaway Postgres built from the same `init-roles.sql`. Things that
only that rehearsal caught: a deadlock when two admins demote each other at once (admin rows are now
locked in id order), a too-short password answered with 500 instead of 400, and semgrep flagging
`secretBox.js` for not pinning the AES-GCM tag length (a real weakness, now fixed).

### Phase P — Hardening pass (2026-11-05)

Design notes and what the testing found: `docs/K8S_MIGRATION.md` Phase 8. The method is the
reusable part: **test a tightening on a copy of the live data in a throwaway container with the exact
flags the manifest will carry, and run a real request, not just "does it start"**.
```bash
# 1. digests of what is RUNNING (so pinning changes nothing about what runs)
kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.name}{" "}{range .status.containerStatuses[*]}{.imageID}{" "}{end}{"\n"}{end}'
# 2. try a tighter securityContext on a COPY of the data (root-only copy, deleted afterwards)
sudo cp -a /var/lib/rancher/k3s/storage/pvc-*_gametorrent_jackett-config /tmp/x
docker run -d --read-only --cap-drop ALL --cap-add CHOWN --cap-add SETUID --cap-add SETGID \
  --security-opt no-new-privileges --tmpfs /run:exec,size=64m -v /tmp/x:/config -p 127.0.0.1:18117:9117 <image@digest>
#    (docker's --tmpfs is noexec by default, kubernetes' memory emptyDir is not: add ,exec for s6 images)
# 3. ask the cluster to validate the real manifests without applying anything
kubectl kustomize k8s/jackett | kubectl apply --dry-run=server -f -
# 4. adopt a hand-applied stack into Argo CD safely: manual mode first, look, sync once, then automate
kubectl -n argocd get application observability -o jsonpath='{range .status.resources[*]}{.kind}/{.name} {.status}{"\n"}{end}'
```

### Phase Q — Host firewall, Docker off, reboot (2026-11-05)

Why and what it protects: `docs/K8S_MIGRATION.md` Phase 9. The order matters, because the firewall is the
one step here that can lock you out of the VM:
```bash
# 1. read-only inventory first: what listens, what Cilium does, what Docker holds, is a reboot pending
sudo ss -H -tulpn; kubectl -n kube-system get cm cilium-config -o yaml | grep -E 'routing-mode|kube-proxy'
cat /var/run/reboot-required
# 2. Docker: archive the small volumes, remove containers + images, switch the service off
sudo tar czf /var/backups/gametorrent/docker-volumes-final-<date>.tgz -C /var/lib/docker/volumes <small volumes>/_data
docker rm <3 stopped containers>; docker image prune -a -f
sudo systemctl disable --now docker.socket docker.service containerd.service   # k3s has its own containerd
# 3. baseline: from ANOTHER machine, which ports answer? (the loop in Part 1 section 14c) -> all open
# 4. arm an automatic rollback, THEN apply:
sudo systemd-run --unit=gt-fw-rollback --on-active=420 /usr/sbin/ufw disable
sudo /usr/local/sbin/gametorrent-firewall.sh
# 5. test with NEW connections from the other machine (an existing ssh session survives regardless),
#    and test the cluster: new pod -> node ports, Argo refresh, Prometheus targets, a real request
# 6. only then cancel the rollback, then reboot:
sudo systemctl stop gt-fw-rollback.timer
sudo systemctl reboot
# 7. if the DHCP address changed, find it by MAC:  cicd/ansible/scripts/resolve-vm-ip.sh <vm-mac>
```
Gotchas met: Docker's `--tmpfs` is `noexec` by default while Kubernetes' in-memory volumes are not (s6
images need `,exec`); `docker rm` without `-v` leaves an anonymous volume per postgres test container
(400 MB leaked before I noticed; the helpers use `rm -fv` now); this PC is not on the tailnet, so
Tailscale could not be used as a fallback route and inbound-over-Tailscale could not be tested.

### Phase R — After the VM was suspended for ~6 days (2026-11-12)

The VMware VM (or the PC under it) was suspended from 11-06 to 11-12: no reboot, but the journal is
silent for 141 h, Tailscale logs "slept 141h", the nightly backups of 5 nights did not run (the timer
catches up once on wake-up) and four pods restarted on probe timeouts. Two lasting leftovers, both fixed:

1. **Argo CD showed every app as sync `Unknown`** (`ComparisonError ... failed to decode cached data:
   unexpected EOF`): a cache entry in the repo-server's Redis was cut off mid-write when the VM froze.
   Redis holds only cache (Argo's real state is the Kubernetes objects), so the fix is safe:
   ```bash
   kubectl -n argocd delete pod -l app.kubernetes.io/name=argocd-redis
   kubectl -n argocd annotate application <app> argocd.argoproj.io/refresh=hard --overwrite   # each of the 6
   kubectl -n argocd get applications      # -> Synced / Healthy on the current main commit
   ```
2. **Docker came back to life on its own.** An unmanaged hook,
   `/etc/networkd-dispatcher/carrier.d/50-docker-recover` (from 2026-09-17, never in this repo), restarted
   Docker whenever the NIC regained carrier and ports 3000 and 9120 did not both answer. 9120 was Komodo,
   which is gone, so every resume "recovered" Docker. It is now renamed `50-docker-recover.disabled`
   (non-executable, so networkd-dispatcher ignores it) and Docker, its socket and containerd are stopped.
   The cluster does not need that hook: k3s has its own containerd and Cilium has no Docker dependency.
   Check later with `systemctl is-active docker docker.socket containerd` (expect three `inactive`).

Also known and harmless: the dashboard panel "Volume usage (%)" shows the whole VM disk for every
volume, because k3s local-path volumes are plain directories on one filesystem. Real sizes:
`sudo du -sh /var/lib/rancher/k3s/storage/pvc-*`.

### Phase S — Postgres stuck in crash recovery: AppArmor blocks its signals (2026-11-13)

The VM crashed (kernel BUG, then the automatic reboot onto the freshly installed kernel 7.0.0-43). Postgres
had been killed mid-run, so on the next start it needed crash recovery, and never finished: the webui's
`db-migrate` initContainer waited for it, Uptime Kuma showed the web UI down for 19 h.

Symptoms and how to read them:
```bash
kubectl -n gametorrent logs postgres-0 -c postgres --previous --tail=30
#  "database system was not properly shut down; automatic recovery in progress"
#  "FATAL: could not signal for checkpoint: Permission denied"   <- the cause: EPERM, not corruption
#  ...then "terminating any other active server processes", liveness probe kills it, repeat
sudo journalctl -k -b 0 | grep 'apparmor="DENIED"' | grep 'operation="signal"' | tail -3
#  profile="cri-containerd.apparmor.d" comm="postgres" signal=int peer="cri-containerd.apparmor.d//&unconfined"
```
The "HINT: some data is corrupted, use the last backup" Postgres prints is only its standard message for a
recovery that was interrupted; the redo itself was a few hundred bytes and the data files were fine.

Cause: containerd's default AppArmor profile does not let a container's processes signal each other when the
peer carries the stacked label `//&unconfined`. It had been happening all along (thousands of denied
`SIGURG`/`SIGUSR1` a day, even on kernel -42, harmless), but the end-of-recovery checkpoint is requested with
`SIGINT` to the checkpointer, so the first unclean stop turned it into a permanent loop.

Fix: `appArmorProfile: type: Unconfined` on the postgres container only (`k8s/postgres/statefulset.yaml`). The
pod is still non-root (uid 70), has no capabilities, a read-only root filesystem and seccomp RuntimeDefault.
Rolling it out: merge `dev` to `main` (Argo CD updates the StatefulSet); a StatefulSet does not replace a pod that
is not Ready on its own, so if `postgres-0` is still the old crash-looping one afterwards, delete that pod
(`kubectl -n gametorrent delete pod postgres-0`; the data is on the PVC) and the new one starts under the new profile.
Do NOT hand-patch the live StatefulSet and switch off Argo CD's self-heal to get around waiting for the merge:
that leaves the cluster out of step with git.

Other findings from the same check: the unattended upgrade installed kernel -43 on 2026-11-13 05:15 and the
crash-reboot at 08:57 booted into it; the nightly backup refuses to run while Postgres is down (correct: it
fails instead of silently skipping the dump); `argocd-notifications-controller` keeps restarting (not yet looked into).

## A real mistake worth knowing about, for next time

After one commit, the local repo was left checked out on `main` instead of switching back to
`dev`. Two unrelated pieces of work (the metrics-server doc, the entire NetworkPolicy work) got
committed directly onto local `main` and never pushed anywhere — `dev` on GitLab was missing
them entirely, which is exactly what looked like "nothing got updated." Caught by comparing
`git log origin/dev` against local branches rather than trusting either blindly — see Part 1
§11 for the check that catches this.

Separately, three times during this project an Argo CD `Application` manifest was written and
committed to git but never actually `kubectl apply`'d to the live cluster (`jackett`,
`network-policies`, `metrics-server`) — the file existing in the repo doesn't mean Argo CD is
managing it; `kubectl -n argocd get applications` (Part 1 §5) is what actually tells you.

Third: a fix was declared durable ("survives a reboot") in this doc's own earlier text without
ever actually testing it across a real reboot — it was a direct edit to one of k3s's own
bundled addon manifest files, and k3s silently reverts that entire directory to its embedded
defaults on every k3s restart, not just first install. Took about a week (until the VM's next
routine reboot) for this to surface. The lesson generalizes: a claim like "this persists" is a
testable fact, not a reasonable-sounding assumption — if you haven't actually forced the
condition (here: a real reboot) and re-checked, say "untested" rather than asserting it. See
Part 1 §0/§1 for how to tell if the VM has rebooted recently (`uptime -p`), which is exactly
what caught this one.

Fourth: a red pipeline can sit unnoticed: a new `body-parser` advisory failed `trivy-fs` on every `dev`
push from 2026-10-24, which silently skipped build/scan/push behind it — five commits landed
on top of it over three days before anyone looked. GitLab doesn't alert on a failing `dev`
pipeline. Check Part 1 §10 after pushing, not just that the push succeeded. (Fixed 2026-10-27:
`npm audit fix` — two patch bumps, nothing else.)

Fifth: a migration moves the data and the backups don't follow. The 2026-10-10 cutover moved the
app's data into a PVC, and the backup job kept succeeding against the old volume for 25 days
(Part 2 Phase N). Any time data moves, re-point the backup and open the newest archive to check
it holds today's files (Part 1 §15). The database cutover was done with that in mind: the backup
script was extended to include a `pg_dump` *before* the cutover, and the dump was test-restored into a
scratch database afterwards.

Sixth: "it starts" is not "it works". A tightened Jackett (`SETUID`+`SETGID` only) came up, answered
its health check and ran as the right user, and every search still failed because it could no longer
hand `/run/jackett-temp` to its own user. Only an actual search against a copy of the data showed it.
Before trusting any hardening, exercise the thing the app is *for*.
