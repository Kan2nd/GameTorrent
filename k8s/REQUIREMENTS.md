# Requirements — k3s deployment

Status: **preparation only — nothing in this folder is deployed yet.** See
[`../docs/K8S_MIGRATION.md`](../docs/K8S_MIGRATION.md) for the phased plan this fits into, and
[`README.md`](README.md) for what's actually in this folder.

## Hardware (checked against `kan2server`, 2026-10-08)

| Resource | Have | k3s + Argo CD + this app need | Verdict |
|---|---|---|---|
| CPU | 6 vCPU | ~1 core for k3s control plane + Argo CD at idle | OK — plenty of headroom |
| RAM | 6.2GB (4.9GB available at check time) | k3s control plane: ~500MB–1GB. Argo CD: ~500MB–1GB across its components. The app itself idles under 50MB | OK |
| Disk, root `/` | **48GB, 31GB free** (was 24GB/2.9GB free — see below) | k3s + its bundled images (Traefik, CoreDNS, local-path-provisioner, metrics-server) + Argo CD's images + this app's image, pulled via containerd **separately from Docker's own image store** (they don't share a cache) | OK now, was NOT OK before two fixes |

**What was wrong and what was done about it (2026-10-08), both already applied, nothing here is still pending:**
1. **5GB of pure waste reclaimed.** Unused images left over from auditing this VM directly with
   `docker run` (semgrep, trivy, gitleaks, mongo, an old `gametorrent-poc` build) plus 2.6GB of
   stale Docker build cache — none had a running container attached, confirmed with
   `docker system df -v` before removing anything.
2. **24GB of already-allocated-but-unused disk, actually used.** `vgs`/`lvs` showed the VM's LVM
   volume group was created at 48GB but the root logical volume was only ever extended to 24GB —
   24GB sat idle in the volume group the whole time. `lvextend -l +100%FREE` +
   `resize2fs` (ext4, online, zero downtime) gave the root filesystem the rest. No VMware-side
   disk resize was needed — the space was already there, just never allocated to the OS partition.
   Verified every running container was still healthy immediately after.

**If you ever see disk pressure again:** re-run `docker system df -v` and `df -h /` first — it's
more often reclaimable waste than genuinely needing more space.

## Software versions (pinned — see `log/M5-supply-chain.md` on why not "latest")

| Component | Version | Where it's pinned |
|---|---|---|
| k3s | `v1.37.1+k3s1` | `cicd/ansible/roles/k3s/defaults/main.yml` |
| Argo CD | `v3.5.4` | same file |
| kubectl | bundled with k3s (`/usr/local/bin/kubectl`, symlinked to the k3s binary) — no separate install | — |
| busybox (init container, manifests) | `1.36` | `k8s/webui/deployment.yaml` — same tag already used in `docker/host/` |

## Network / ports

| Port | What | Exposure |
|---|---|---|
| 6443 | k3s API server | LAN/Tailscale only — **never** put this on the public tunnel (same reasoning as closing off Komodo's `:9120` in `log/C2`) |
| 10250 | kubelet | localhost/cluster-internal only (k3s default) |
| 80, 443 | Traefik (k3s's bundled ingress) | not used by this deployment yet — `hostPort: 3000` is used instead for parity with the Docker deployment's existing bookmarks. Free on this VM; no clash. |
| 3000 | the app itself, via `hostPort` on the pod | same exposure as today's Docker container — LAN/Tailscale, not public |
| Argo CD UI | — | **deliberately not exposed** via NodePort or Ingress. Reach it with `kubectl -n argocd port-forward svc/argocd-server 8080:443` over an SSH or Tailscale connection. It's a deploy-capable admin panel — the exact thing `log/C2` was about not putting on the open LAN/internet without a reason. |

Checked for clashes against the live Docker stack's ports (22, 53, 3000, 3001, 9117, 9120, 9180,
plus cloudflared/Tailscale's own) — none.

## Container registry

k3s pulls images; it doesn't build them locally the way Komodo's `run_build: true` does for
Docker. This needs a registry. Plan: push to **GitLab's Container Registry**
(`registry.gitlab.com/kannguyen3105/gametorrent/...`) — free, already part of this GitLab
project, and the CI job that builds the image (`build-image` in `cicd/.gitlab-ci.yml`) just needs
a push step added using GitLab's existing `CI_REGISTRY_*` predefined variables. **Not done yet**
— `k8s/webui/deployment.yaml`'s image field is a placeholder until this exists.

## New things this adds to the security audit scope

Not yet reviewed with the same depth as `log/` covers the Docker deployment. At minimum, before
calling this production-ready: the k3s API server's own auth/RBAC defaults, Argo CD's RBAC and
whether its `Application` sync credentials are scoped sensibly, and that k3s ships with **no
NetworkPolicy by default** — any pod can talk to any other pod in the cluster unless one is
added. Low stakes while it's just one app in the cluster; worth revisiting before adding a second.

## Known limitation, shared with the Docker deployment

Single node. This doesn't add high availability — it adds Kubernetes' primitives (self-healing,
declarative manifests, a standard ecosystem) on the *same* single point of failure the Docker
deployment already has. Said plainly in `docs/K8S_MIGRATION.md` too — worth repeating here since
it's easy to assume otherwise once "Kubernetes" is in the sentence.
