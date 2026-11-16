# Host files for kan2server

Everything here is installed on the VM at the **same path** it has under this folder
(`docker/host/usr/local/bin/x.sh` → `/usr/local/bin/x.sh`). Kept in Git so the VM's own setup is
reviewable and rebuildable, not just the containers.

| File | What it does |
|---|---|
| `usr/local/bin/gametorrent-backup.sh` + `gametorrent-backup.{service,timer}` | Nightly 03:30 UTC: a `pg_dump` of the webui's PostgreSQL database (via `kubectl exec`, verified with `pg_restore --list`) plus the live k3s PVCs `webui-data`, `jackett-config`, `uptime-kuma-data` (read from `/var/lib/rancher/k3s/storage/`), into `/var/backups/gametorrent/live-pvc-<date>.tgz`, verified, newest 7 kept |

| `usr/local/sbin/gametorrent-firewall.sh` | The host firewall (ufw): default deny incoming; SSH and the apps from the LAN and Tailscale; the Kubernetes API over Tailscale only; pods to the node; everything else (kubelet, Hubble, Cilium ports) closed. Idempotent; `--dry-run` prints the rules. Background and the safe way to apply it: `docs/K8S_MIGRATION.md` Phase 9, `docs/DEBUG.md` Part 2 Phase Q |

These files live under `docker/` for historical reasons; none of them touches Docker any more.

Docker itself stays **off** (stopped, nothing installed from it is used). On 2026-11-12 an old unmanaged host hook, `/etc/networkd-dispatcher/carrier.d/50-docker-recover`, was found restarting it after every VM resume; it is renamed `*.disabled` on the VM. See `docs/DEBUG.md` Phase R.

**Retired 2026-10-10:** the Cloudflare quick tunnel + webhook-only Caddy proxy
(`docker/webhook-proxy/`, `cloudflared-komodo-tunnel.service`,
`cloudflared-watchdog.*`) existed only to let GitLab's push webhook reach
Komodo's `gametorrent-webui` deploy listener from the internet — see
`docs/GITOPS.md` §6 and `docs/CLOUDFLARE_TUNNEL.md` for the full history.
Now that `gametorrent-webui` deploys via Argo CD (pull-based polling, no
public endpoint needed at all — see `docs/K8S_MIGRATION.md`), that whole
inbound path serves no purpose. The GitLab webhook was deleted, the tunnel
and watchdog services were stopped/disabled on the VM, and their unit
files removed here. (Komodo itself was retired entirely on 2026-10-13 and its
images removed in Step D, see `docs/K8S_MIGRATION.md`.)

Install / update on the VM (strip Windows line endings first if copying from a Windows checkout).
For the firewall, **arm the auto-rollback first** (it can lock you out of SSH if a rule is wrong):

```bash
sudo install -m 750 -o root -g root docker/host/usr/local/sbin/gametorrent-firewall.sh /usr/local/sbin/
sudo systemd-run --unit=gt-fw-rollback --on-active=420 /usr/sbin/ufw disable   # undo in 7 min if you lose the VM
sudo /usr/local/sbin/gametorrent-firewall.sh
# open a NEW ssh session to prove it still works, then:  sudo systemctl stop gt-fw-rollback.timer
```

The backup script and its timer:

```bash
sudo install -m 750 -o root -g root docker/host/usr/local/bin/gametorrent-backup.sh /usr/local/bin/
sudo install -m 644 -o root -g root docker/host/etc/systemd/system/gametorrent-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gametorrent-backup.timer
sudo systemctl start gametorrent-backup.service && journalctl -t gametorrent-backup -n 1 -o cat
```

Restore one app's data from a backup (example: the webui). Argo CD's selfHeal would undo a
`kubectl scale`, so pause the app's sync first:

```bash
B=/var/backups/gametorrent/live-pvc-<date>.tgz
kubectl -n argocd patch application gametorrent-webui --type merge -p '{"spec":{"syncPolicy":{"automated":null}}}'
kubectl -n gametorrent scale deployment/gametorrent-webui --replicas=0
D=$(sudo sh -c 'ls -d /var/lib/rancher/k3s/storage/pvc-*_gametorrent_webui-data')
sudo sh -c "rm -rf '$D'/* && tar xzf $B --numeric-owner -C '$D' --strip-components=1 webui-data"
kubectl -n gametorrent scale deployment/gametorrent-webui --replicas=1
kubectl -n argocd patch application gametorrent-webui --type merge -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}'
```
Swap `webui-data` for `jackett-config` / `uptime-kuma-data` (and the deployment/app names) for
the others. `--numeric-owner` keeps the original uids (webui 1000, Jackett 911, Kuma 1000 since 2026-11-05, root in older archives).
Tested 2026-11-04: the `tar` extract step, into a temp dir, matched the live PVC byte for byte.
The scale-down/Argo-pause steps haven't been exercised in a real restore yet.

Restore the **database** (users, requests, history, audit log) from the same archive. This
replaces everything in it, so stop the app first:

```bash
B=/var/backups/gametorrent/live-pvc-<date>.tgz
kubectl -n argocd patch application gametorrent-webui --type merge -p '{"spec":{"syncPolicy":{"automated":null}}}'
kubectl -n gametorrent scale deployment/gametorrent-webui --replicas=0
sudo tar xzf $B -O gametorrent.pgdump | kubectl -n gametorrent exec -i postgres-0 -c postgres -- \
  pg_restore -U postgres -d gametorrent --clean --if-exists --no-owner --role=gt_owner
kubectl -n gametorrent scale deployment/gametorrent-webui --replicas=1
kubectl -n argocd patch application gametorrent-webui --type merge -p '{"spec":{"syncPolicy":{"automated":{"prune":true,"selfHeal":true}}}}'
```
Not yet exercised against the live database; do a test restore into a scratch database first if
you ever need it for real.

**Caveats:** the archives sit on the same disk as the data, so they cover mistakes and corruption,
not a dead disk or a lost VM. Uptime Kuma's SQLite file is copied while running
(crash-consistent; see the script header).

**History:** from the 2026-10-10 k3s cutover until 2026-11-04 this script kept tarring the old
Docker volume `gametorrent-webui-data`, so every nightly archive was the same stale snapshot.
The Docker-era `webui-data-*.tgz` files are still in `/var/backups/gametorrent/`, no longer
rotated, and the old script is at `/usr/local/bin/gametorrent-backup.sh.docker-era.bak`. See
`docs/DEBUG.md` Part 2 Phase N.
