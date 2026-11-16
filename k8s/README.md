# k3s deployment

Status, 2026-11-04: **everything here is live** — `webui/` (cut over 2026-10-10, Phase 4),
`jackett/` and `uptime-kuma/` (cut over 2026-10-13, Phase 5), `network-policies/` and
`metrics-server/` (Argo CD-managed), and `observability/` (Loki + Alloy + Prometheus +
kube-state-metrics + Grafana — logs AND metrics, Argo CD-managed since 2026-11-05; only its namespace and
`grafana-secret` stay hand-applied). Every image is pinned by digest (the webui through the kustomize
pin that [`../docs/CI_CD.md`](../docs/CI_CD.md) "Releasing" describes). See
[`../docs/K8S_MIGRATION.md`](../docs/K8S_MIGRATION.md) for how each got there and what was hit
along the way, and [`REQUIREMENTS.md`](REQUIREMENTS.md) for the hardware/software/network checks
done against the target VM. Komodo, which used to deploy the webui app on Docker, is retired —
nothing left for it to manage once everything moved here.

Namespaces: `gametorrent` (the three apps + the webui's PostgreSQL), `observability` (logs and metrics), `argocd` (GitOps),
`kube-system` (Cilium, CoreDNS, Traefik, metrics-server, Hubble Relay).

## Layout

```
k8s/
├── namespace.yaml          # the `gametorrent` namespace (also created by the ansible role)
├── webui/                  # the app itself — translated 1:1 from docker/webui-compose.yml
│   ├── kustomization.yaml   # explicit resources list (+ ../postgres); secret.yaml is NOT in it (applied by hand)
│   ├── pvc.yaml             # 4 PersistentVolumeClaims, one per Docker named volume
│   ├── secret.example.yaml  # copy to secret.yaml (gitignored) and fill in real values
│   ├── deployment.yaml      # same hardening as the Docker deployment; db-migrate initContainer runs migrations as gt_owner
│   └── service.yaml
├── postgres/               # the webui's database, deployed BY the gametorrent-webui Argo CD app (pulled in by webui/kustomization.yaml)
│   ├── statefulset.yaml     #   Postgres 17 pinned by digest, uid 70, read-only rootfs, no caps, 2Gi volume
│   ├── service.yaml         #   ClusterIP only; NetworkPolicy lets only the webui in
│   ├── init-roles.sql       #   first-boot role setup: gt_owner (schema), gt_app (app; audit log insert-only)
│   ├── 10-gametorrent-roles.sh  # passes the role passwords to init-roles.sql as psql variables
│   ├── secret.example.yaml  #   three Secrets (postgres-credentials, webui-db-migrate, webui-db), applied by hand
│   └── kustomization.yaml
├── jackett/                # LIVE — torrent-indexer proxy; reachable in-cluster as http://jackett:9117 (root-start s6 init, but only CHOWN/SETUID/SETGID)
│   └── kustomization.yaml, pvc.yaml, deployment.yaml, service.yaml
├── uptime-kuma/            # LIVE — uptime monitor; runs as uid 1000 with every capability dropped
│   └── kustomization.yaml, pvc.yaml, deployment.yaml, service.yaml
├── network-policies/       # LIVE — default-deny + explicit allows for gametorrent, isolates argocd
│   └── kustomization.yaml + one file per policy (incl. webui -> postgres), see docs/K8S_MIGRATION.md's security-review section
├── metrics-server/         # LIVE — replaces k3s's own bundled copy (its v0.9.0 build has a real bug,
│   │                         and a direct file-edit workaround wasn't durable — see docs/DEBUG.md)
│   └── kustomization.yaml, rbac.yaml, service.yaml, apiservice.yaml, deployment.yaml (pinned to v0.8.1)
├── observability/          # LIVE (Argo CD-managed) — logs + metrics, its own `observability` namespace
│   ├── namespace.yaml       #   applied by hand, NOT in kustomization (Argo CD prune can never delete it)
│   ├── loki.yaml            #   log store, single-binary mode, 7-day retention, 5Gi PVC
│   ├── alloy.yaml           #   log collector — reads every pod's logs via the k8s API (no hostPath)
│   ├── prometheus.yaml      #   metrics store: scrapes kubelet/cAdvisor + kube-state-metrics, 15d/3GB retention, 5Gi PVC
│   ├── kube-state-metrics.yaml  # restarts / readiness / replica counts (what Kubernetes *believes*)
│   ├── grafana.yaml         #   query UI; Loki + Prometheus provisioned as datasources, dashboard from git; port-forward only
│   ├── dashboards/cluster-overview.json  # the starter dashboard (metrics + logs); becomes a ConfigMap via kustomize
│   ├── networkpolicy.yaml   #   default-deny + only the named paths (see the file's header for the full list)
│   ├── grafana-secret.example.yaml  # copy to grafana-secret.yaml (gitignored), applied by hand
│   └── kustomization.yaml
└── argocd/
    ├── application.yaml                 # gametorrent-webui — the GitOps part
    ├── application-jackett.yaml         # same pattern, path k8s/jackett
    ├── application-uptime-kuma.yaml     # same pattern, path k8s/uptime-kuma
    ├── application-network-policies.yaml  # same pattern, path k8s/network-policies
    ├── application-metrics-server.yaml    # same pattern, path k8s/metrics-server
    └── application-observability.yaml     # same pattern, path k8s/observability
```

How the pieces connect at runtime:

```
                          ┌──────────────── observability ns ────────────────┐
every pod's stdout ──API──> Alloy ──push──> Loki (PVC) ──┐
                          │                                 ├─query─> Grafana <── you, via port-forward
kubelet/cAdvisor ──scrape──> Prometheus (PVC) ──────────┤  (one dashboard, both signals)
kube-state-metrics ─scrape─┘   (restarts, readiness)     │
                          └────────────────────────────────────────────────────┘
network flows (eBPF) ──> Cilium ──> Hubble Relay (kube-system) <── `hubble observe`, via port-forward
pod CPU/RAM (now) ──> kubelet ──> metrics-server (kube-system) <── `kubectl top`  (current value only; no history)
browser ──:3000──> webui ──5432──> PostgreSQL (gametorrent ns; nothing else may connect, it may connect to nothing)
git (main) ──poll──> Argo CD (argocd ns) ──reconcile──> everything above except the hand-applied pieces
```

## How this would actually get applied (once you say go — see K8S_MIGRATION.md Phase 1)

1. `cicd/ansible/k3s-playbook.yml` — installs k3s + Argo CD on the VM (alongside Docker, not
   replacing it). Prerequisites already checked: `REQUIREMENTS.md`.
2. `kubectl apply -f k8s/namespace.yaml` (the ansible role also does this as part of bootstrap).
3. `cp k8s/webui/secret.example.yaml k8s/webui/secret.yaml`, fill in real values. This file is
   gitignored — it never gets committed, and Argo CD syncing from git will **not** see it or
   manage it; apply it by hand once: `kubectl apply -f k8s/webui/secret.yaml`.
4. `cp k8s/argocd/repo-secret.example.yaml k8s/argocd/repo-secret.yaml`, paste a GitLab token
   scoped to `read_repository` only (Settings → Access tokens → role Reporter — don't reuse the
   broad `api`-scope personal token), `kubectl apply -f k8s/argocd/repo-secret.yaml`. This is what
   lets Argo CD clone the private `kannguyen3105/gametorrent` repo at all.
5. `kubectl apply -f k8s/argocd/application.yaml` — from this point on, Argo CD takes over:
   it polls this repo's `main` branch and reconciles `k8s/webui/` against the live cluster.
6. Test on a different port/PVC set first, migrate the real Docker volumes' data across, *then*
   swap the live `:3000` over. Exact steps: `docs/K8S_MIGRATION.md` Phase 4.

## Why a Deployment, not a StatefulSet

The app is a single replica with its state entirely in PVCs it mounts by name — a StatefulSet's
extra guarantees (stable network identity, ordered rollout across *multiple* replicas) don't buy
anything here. `strategy: Recreate` on the Deployment already gets the one thing that matters:
never two pods mounting the same `ReadWriteOnce` PVC at once.

## Honesty check

This folder optimizes **structure** (declarative manifests, k8s's self-healing, a standard
ecosystem) — it does not add high availability. It's still one VM, one node, one disk. See the
"Known limitation" note at the bottom of `REQUIREMENTS.md`.
