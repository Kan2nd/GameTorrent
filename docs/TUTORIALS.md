# Tutorials: logs, image signing, Kuma notifications, and metrics

These three are meant to be followed hands-on, not applied for you — each section explains what
you're about to run and why before giving you the command. The files these reference already
exist in the repo (committed to `dev`), so you're deploying/wiring real, already-reviewed
manifests — not writing them from scratch.

---

## 1. Log aggregation — Loki + Grafana Alloy + Grafana

### What each piece actually does

```
every pod's logs ──(Alloy reads via the k8s API, same as `kubectl logs`)──> Loki (stores + indexes)
                                                                                    │
                                                                      you query them in Grafana
```

- **Loki** — stores and indexes logs, queryable by label (namespace, pod, container) and text.
  Think "the database."
- **Grafana Alloy** — finds every pod, tails its logs, forwards them to Loki. Think "the
  collector." (Not Promtail — Promtail's been end-of-life since 2026-03-02; Alloy is Grafana's
  current recommendation and absorbed Promtail's functionality.)
- **Grafana** — the UI you actually query and build dashboards in. Think "the window."

Manifests: `k8s/observability/` (`namespace.yaml`, `loki.yaml`, `alloy.yaml`, `grafana.yaml`,
`grafana-secret.example.yaml`, `kustomization.yaml`). Already Trivy-scanned clean (confirmed in
the CI log: 0 misconfigurations on every file in that folder).

**Status as of 2026-11-05:** all steps are done — Loki has logs from `argocd`, `gametorrent`,
`kube-system` and `observability`, and Step 6 (handing it to Argo CD) happened on 2026-11-05.

**Network isolation (added 2026-10-27, `k8s/observability/networkpolicy.yaml`):** Loki runs
with `auth_enabled: false`, so its protection is the network, not a login. Before the policy, a
pod in `argocd` could reach it (confirmed by test) and read every pod's logs or inject fake
ones. Now `observability` is default-deny: only Alloy and Grafana may talk to Loki, and nothing
else can reach Grafana's port either. Verified live — a pod in `argocd` and one in `default` are
both blocked from Loki and Grafana (Hubble logs them as `Policy denied DROPPED`), while Alloy
still ships logs and Grafana's Loki datasource reports healthy. `kubectl port-forward` is
unaffected, so every access recipe below still works.

Two honest limits: traffic from the node itself (or a `hostNetwork` pod) can still reach pods
— that's Cilium's default for kubelet health probes and isn't something this policy changes —
and Loki still has no authentication of its own, so anything *allowed* to reach it can read
everything. If you ever add a second tenant or expose Loki, turn on `auth_enabled`.
When Alloy is restarted it replays recent history and Loki rejects entries older than its
out-of-order window (`entry too far behind`, HTTP 400) — expected, not a failure.

### Step 1 — pick a Grafana admin password and create the real secret

```bash
cp k8s/observability/grafana-secret.example.yaml k8s/observability/grafana-secret.yaml
# edit grafana-secret.yaml, replace CHANGE_ME with a real password
```
This file is gitignored (same as `k8s/webui/secret.yaml`) — it never gets committed.

### Step 2 — copy the manifests to the VM and apply them

```bash
# from your PC, in the repo root
scp -r k8s/observability <ssh-user>@<vm-ip>:/tmp/observability

# then on the VM
ssh <ssh-user>@<vm-ip>
export KUBECONFIG=$HOME/.kube/config
kubectl apply -f /tmp/observability/namespace.yaml
kubectl apply -f /tmp/observability/grafana-secret.yaml
kubectl apply -k /tmp/observability/
```
`namespace.yaml` and the secret are applied separately, by hand, on purpose — same pattern as
every other app in this cluster (`k8s/webui/kustomization.yaml`'s own comment explains why):
Argo CD never manages the namespace or anything holding a real credential.

### Step 3 — watch it come up

```bash
kubectl -n observability get pods -w
```
Expect three pods: `loki-...`, `alloy-...`, `grafana-...`, all reaching `1/1 Running` within
about a minute (each image needs to be pulled the first time). If `alloy` specifically
crash-loops with a permissions error, see the note in `k8s/observability/alloy.yaml`'s own
comment — its non-root UID is an upstream-acknowledged "experimental, undocumented" feature, and
the fix (matching what this repo already did for Jackett/Kuma) is removing the
`runAsNonRoot`/`runAsUser`/`runAsGroup` lines from its `securityContext` so it runs as the
image's real default (root) instead.

### Step 4 — confirm Loki is actually receiving logs

Not `kubectl exec` into the Loki pod — its official image is a minimal build with no shell
tools at all (confirmed hitting `wget: executable file not found` here). Port-forward instead
and query it from the VM's own shell, same pattern used everywhere else in this project:
```bash
export KUBECONFIG=$HOME/.kube/config
kubectl -n observability port-forward svc/loki 3100:3100 &
sleep 2
curl -s 'http://localhost:3100/loki/api/v1/label/namespace/values'
```
Want to see `"gametorrent"`, `"argocd"`, `"observability"` etc. in the response — that's Loki
confirming it's actually indexed logs from those namespaces, not just that the pod is up.

### Step 5 — reach Grafana and look at real logs

Not port `3001` on either end — that's already `uptime-kuma`'s `hostPort` on this same VM
(`k8s/uptime-kuma/deployment.yaml`). Using it again risks the same kind of silent conflict this
project already hit once with Docker's `docker-proxy` quietly holding a port — pick a number
nothing else uses instead:
```bash
# on your PC
ssh -L 3002:localhost:3002 <ssh-user>@<vm-ip>
# in that same ssh session, on the VM
export KUBECONFIG=$HOME/.kube/config
kubectl -n observability port-forward svc/grafana 3002:3000
```
Browse `http://localhost:3002`, log in with the username/password from your
`grafana-secret.yaml`. Loki is already configured as a data source (that's what
`grafana-datasources` ConfigMap does — no manual "Add data source" click needed). Go to
**Explore** (left sidebar), pick the **Loki** data source, and run:
```
{namespace="gametorrent"}
```
You should see real log lines from `webui`/`jackett`/`uptime-kuma`. Narrow it further:
```
{namespace="gametorrent", container="jackett"}
{namespace="gametorrent"} |= "error"
```
That second one is a full-text filter — this is the thing `kubectl logs` can never do: search
*across* every pod's history at once, even ones that already restarted and lost their local log
buffer.

### Step 6 — wire it into git/Argo CD (done 2026-11-05)

How it was done, safely: create the Application with **no automated sync** first, so Argo CD
reports what it thinks differs without touching anything; every object showed `OutOfSync` simply
because none had Argo's tracking label yet (confirm with `git diff` that git matches what you
applied by hand); trigger one manual sync; check no pod restarted; then apply the real file, which
turns on automated sync, prune and self-heal:
```bash
kubectl -n argocd patch application observability --type merge -p '{"operation":{"sync":{"revision":"main"}}}'
kubectl apply -f k8s/argocd/application-observability.yaml
```
Two things stay hand-managed on purpose and are not in the kustomization: the `observability`
namespace and `grafana-secret`, so Argo's prune can never delete the namespace or its data.

---

## 2. Image signing — cosign

### Why this exists

Right now, nothing stops someone with push access to the GitLab Container Registry from
replacing the `:main` tag with a different image, and nothing would notice. Signing proves
"this exact image came from this exact CI pipeline" — a tampered or hand-pushed image won't have
a valid signature, and you can check that before trusting it.

**What signing does NOT do yet:** nothing in the cluster checks signatures. Argo CD and kubelet
will still happily run an unsigned image. After this tutorial, signing is *evidence you can
check by hand*, not a gate. Making it a gate needs an admission controller that rejects
unsigned images (Kyverno's `verifyImages`, or Sigstore's `policy-controller`) — listed as a
next step in `docs/K8S_MIGRATION.md`'s security-review section.

### Step 1 — install cosign locally (your PC, not the VM)

```bash
# Windows (PowerShell), via the same pinned-version pattern this repo uses everywhere else
curl.exe -sSLo cosign.exe "https://github.com/sigstore/cosign/releases/download/v3.1.4/cosign-windows-amd64.exe"
.\cosign.exe version
```
(Linux/WSL: swap the URL for `cosign-linux-amd64` and `chmod +x`.)

### Step 2 — generate the signing keypair yourself

**This is the one step in this whole tutorial you should genuinely run yourself, not hand to an
AI** — a signing key is only trustworthy if its generation had no blast radius beyond you.
```bash
.\cosign.exe generate-key-pair
```
It'll prompt for a password (used to encrypt the private key at rest — pick a real one, you'll
need it again) and produces two files in your current directory:
- `cosign.key` — the **private** key, password-encrypted. Never commit this. Never paste its
  contents into chat with anyone, AI included.
- `cosign.pub` — the **public** key. Safe to commit, safe to share — this is what verification
  uses.

### Step 3 — sign one existing image by hand, to see it actually work

```bash
# log in to the registry first
docker login registry.gitlab.com -u <your-gitlab-username>
# you'll need a GitLab personal access token here, not your password

.\cosign.exe sign --key cosign.key registry.gitlab.com/kannguyen3105/gametorrent/webui:main
```
It'll ask for the key's password, then push a signature alongside the image in the registry
(you'll see a new tag like `sha256-....sig` appear in the registry — that's the signature, not a
new image).

### Step 4 — verify it

```bash
.\cosign.exe verify --key cosign.pub registry.gitlab.com/kannguyen3105/gametorrent/webui:main
```
Should print the signature payload and exit 0. Now try verifying a tag you *never* signed (e.g.
an old commit-SHA tag from before this tutorial) — it should fail, which is the actual point:
verification only succeeds for images that were genuinely signed with your key.

### Step 5 — wire it into CI

The CI job is already written (`cicd/.gitlab-ci.yml`'s `sign-image` job, pushed to `dev`) and
deliberately **dormant** — it won't run at all until you create its two required variables, so it
can't break any pipeline in the meantime. In GitLab: **Settings → CI/CD → Variables → Add
variable**, twice:

| Key | Value | Type | Flags |
|---|---|---|---|
| `COSIGN_PRIVATE_KEY` | the full contents of `cosign.key` (open it in a text editor, paste the whole thing, including the `-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----` lines) | Variable | **Protected only** — see note below |
| `COSIGN_PASSWORD` | the password you chose in Step 2 | Variable | Masked, Protected |

**Why the private key can't be "Masked":** GitLab only masks single-line values. A PEM key is
multi-line (and its header has spaces), so the Masked checkbox will be refused. That's
acceptable here because (a) the key is still encrypted with `COSIGN_PASSWORD`, which *is*
masked, and (b) the `sign-image` job never echoes it to the log — it only writes it to a file
cosign reads. If GitLab also refuses to mask the password, it's the character set: pick a
password made of letters, digits and simple symbols.

**"Protected" means only protected branches see these variables — and in this project that's
`main` only** (checked: `dev` is not a protected branch). So `sign-image` will sign builds of
`main`, and silently skip on `dev`. That's a reasonable default (`main` is what Argo CD
deploys). If you also want `dev` builds signed, protect `dev` in **Settings → Repository →
Protected branches** first — that also restricts who can push to it, so it's a real decision,
not a checkbox.

Once both variables exist, the next merge into `main` will run `sign-image` automatically.
Check it worked the same way as Step 4, just pointed at the commit-SHA tag that pipeline produced
(the job signs `webui:<short-sha>`, not `:main`).

Commit `cosign.pub` to the repo root once you're happy — anyone can then verify with
`cosign verify --key cosign.pub ...` without asking you for anything.

---

## 3. Uptime Kuma notifications

Right now Kuma can see when something's down, but nothing tells *you* — you'd only find out by
opening the dashboard. This is pure UI configuration; Kuma doesn't have a scriptable API for
this, and honestly you want to type the webhook URL/bot token in yourself rather than hand it to
anything else anyway.

### Step 1 — pick a notification channel and get its credential

Pick one (Discord is the lowest-friction if you don't already have something):

- **Discord**: Server Settings → Integrations → Webhooks → New Webhook → copy the Webhook URL.
- **Telegram**: message `@BotFather` → `/newbot` → follow the prompts → copy the bot token. Then
  message your new bot once (anything) so it can find your chat — message `@userinfobot` to get
  your own numeric chat ID.
- **Email**: you'll need real SMTP credentials (e.g. a Gmail app password, not your normal
  password) — more setup than the other two, skip this one unless you already have an SMTP
  relay you trust.

### Step 2 — add it in Kuma

Browse to Kuma (`http://<vm-ip>:3001`, log in), then:
**Settings → Notifications → Setup Notification**
- Name it something you'll recognize (e.g. "Discord - homelab alerts")
- Notification Type: pick the one matching Step 1
- Paste the webhook URL / bot token + chat ID
- Click **Test** — you should get a real message in Discord/Telegram within a few seconds. If
  nothing arrives, the credential from Step 1 is the thing to re-check, not Kuma's config.
- **Save**

### Step 3 — attach it to the monitor(s) that matter

A notification channel existing doesn't do anything until a monitor is told to use it:
- Go to **Monitors → GameTorrent Web UI** (or any other monitor) → **Edit**
- Under **Notifications**, toggle on the one you just created
- **Save**

Repeat for any other monitor you want alerts from. "Default enabled" is also an option on the
notification itself (back in Settings → Notifications → edit it → toggle "Default enabled") if
you want every *future* monitor to use it automatically without this per-monitor step.

### Step 4 — verify it fires on a real event, not just the test button

The test button confirms the credential works, not that Kuma actually triggers it on a real
down event. Prove the real path once:
```bash
# on the VM, briefly scale the webui deployment to 0 so its monitor actually goes down
export KUBECONFIG=$HOME/.kube/config
kubectl -n gametorrent scale deployment/gametorrent-webui --replicas=0
# wait for Kuma's next check cycle (60s interval) - you should get a real "DOWN" alert
kubectl -n gametorrent scale deployment/gametorrent-webui --replicas=1
# wait for the next cycle again - you should get a real "UP" recovery alert
```
Both messages arriving is the actual proof this works end-to-end, not just that the webhook URL
is valid.

---

## 4. Metrics — Prometheus, and the dashboard that ties metrics to logs

Logs tell you *what the app said*. Metrics tell you *how much, and how it changed*: "webui used
35Mi of RAM at 3pm yesterday", "this pod restarted 4 times today". Different question, different
tool — which is why there are now two datasources in Grafana.

```
kubelet/cAdvisor ──scrape every 30s──> Prometheus ──┐
kube-state-metrics ──scrape every 30s──────────────┤──query──> Grafana  (Loki also feeds it: logs)
                                                    └ stores 15 days / 3GB, whichever hits first
```

- **cAdvisor** is built into the kubelet. It measures every container's CPU, memory and network —
  this is where "memory by pod" comes from.
- **kube-state-metrics** reports what Kubernetes *believes*: restarts, Ready or not, replica
  counts. cAdvisor can't know "this pod restarted" — it only sees usage.
- **Prometheus** *pulls* (scrapes) these endpoints on a timer and stores the numbers. That's the
  opposite of Loki, which Alloy *pushes* logs into.
- Not included on purpose: `node-exporter` (needs read access to the host's `/proc`/`/sys`/disk,
  which cuts against the hardening everything else here follows). Node-level CPU/RAM still work
  through cAdvisor's root cgroup. If you later want host disk-free numbers, that's the one
  reason to add it — as a conscious exception.

### Step 1 — look at the dashboard first

Same tunnel as §1 (`ssh -L 3002:localhost:3002 ...` then `kubectl -n observability port-forward
svc/grafana 3002:3000`), browse `http://localhost:3002`, then **Dashboards → "Cluster overview -
metrics + logs"**. Top of the page: a **namespace** dropdown (filters every panel *and* the logs
panel at once) and a **search logs** box.

How to read it:

| Panel | What a problem looks like |
|---|---|
| Pods not Ready | Anything above 0: a pod is Running but failing its readiness check |
| Container restarts (24h) | Above 0 = something crashed. A crash loop shows here before anywhere else |
| Memory by pod | A line climbing steadily and never dropping = a memory leak; flat-lining at the limit then vanishing = OOM-killed |
| CPU by pod | `1.0` = one full core (the VM has 6). A pod pinned high for long is the one to investigate |
| Volume usage | Per PVC. `local-path` has **no quota**, so 100% here means "used what was requested", not a hard stop — the real limit is the node's disk |
| Log volume / Error lines | From **Loki**, not Prometheus. A jump for one container is often the first symptom |

The point of one dashboard with both: when a memory line jumps, look straight down at the log
panel for the *same time window* instead of switching tools.

### Step 2 — PromQL, by comparison with the LogQL you already know

LogQL (Loki) and PromQL (Prometheus) both start with a `{label="value"}` selector, but they
select different things: LogQL selects *log streams*, PromQL selects *number series*.

```promql
container_memory_working_set_bytes{namespace="gametorrent"}            # one number per container, right now
sum by (pod) (container_memory_working_set_bytes{namespace="gametorrent", container!=""})   # add up per pod
rate(container_cpu_usage_seconds_total{namespace="gametorrent"}[5m])    # CPU: it's a running total, so take its rate
increase(kube_pod_container_status_restarts_total[24h])                 # how many restarts in the last day
```
Two ideas worth getting straight:

- **Counters vs gauges.** Memory is a *gauge* (it goes up and down — read it directly). CPU time,
  network bytes and restarts are *counters* (only ever go up — meaningless alone, so you wrap them
  in `rate()` or `increase()` to get "per second" or "over this window").
- **`container!=""`** appears because cAdvisor also reports a pod-level total with an empty
  container label; without the filter you'd count everything twice.

In Grafana: **Explore** → pick the **Prometheus** datasource → type a query. Same **Builder** /
**Code** toggle as Loki, and the dropdowns fetch real metric and label names from Prometheus.
Metric names: start typing `container_` or `kube_` and it autocompletes.

### Step 3 — where the labels come from

| Label | Source |
|---|---|
| `namespace`, `pod`, `container` | cAdvisor / kube-state-metrics, straight from Kubernetes (so they match Loki's — that's why one dropdown filters both) |
| `node` | Added by our own Prometheus config from the node's *name*, on purpose |
| `instance` | Prometheus's default: the scrape address. For the kubelet that's the node's **DHCP-leased IP**, which changes — so never build a query or dashboard on `instance` here; use `node` |

### Step 4 — edit the dashboard (it lives in git)

The dashboard is provisioned from `k8s/observability/dashboards/cluster-overview.json`, so it
survives a Grafana rebuild instead of existing only in a browser session. That also means the
UI copy is **read-only**: to change it, edit the JSON, apply, and restart Grafana:
```bash
kubectl apply -k /tmp/observability/        # after copying the folder to the VM, as in §1 Step 2
kubectl -n observability rollout restart deployment/grafana
```
Easy workflow: build/tweak a panel in a *new* dashboard in the UI (which is editable), then
**Share → Export → JSON** and paste the panel into the file.

### Honest limits

- **No tracing yet.** That's the third APM signal ("which function inside the app was slow") and
  needs OpenTelemetry added to the webui's own code plus a tracing backend (Tempo). Metrics + logs
  cover "is it healthy / what changed / what did it say", not "why was *this request* slow".
- **No alerting.** Prometheus and Grafana can fire alerts, but nothing is routed anywhere yet.
  Uptime Kuma (§3) is still the thing that actually pings you.
- **Metrics only know what Kubernetes knows.** webui-specific numbers (downloads in progress,
  login failures) don't exist unless the app exposes a `/metrics` endpoint — also an app-code change.
