#!/bin/sh
# Host firewall for kan2server (ufw). Idempotent: wipes ufw's rules and re-applies exactly these.
#
#   sudo /usr/local/sbin/gametorrent-firewall.sh            # apply (and enable)
#   sudo /usr/local/sbin/gametorrent-firewall.sh --dry-run  # print what it would do
#
# WHAT IT PROTECTS. Before 2026-11-05 the VM had no host firewall: besides SSH, anyone on the LAN
# could reach the Kubernetes API (6443), the kubelet (10250), and Cilium/Hubble's unauthenticated
# ports (4244 flow data, 4240, 9962-9964 metrics).
#
# WHAT IT CAN'T PROTECT, by design of the setup: the app ports 3000 (webui), 3001 (Kuma) and 9117
# (Jackett) are pod hostPorts. Cilium (eBPF, kube-proxy replacement) hands those packets to the pod
# in the network driver, BEFORE the kernel's firewall sees them, so ufw never gets to filter them.
# The rules for them below are belt and braces (they matter if that ever changes); the real
# controls on those ports are the apps' own logins and the NetworkPolicies in k8s/network-policies.
#
# WHY THESE SOURCES.
#   LAN       192.0.2.0/24 is the VMware NAT network; the admin PC shows up as 192.0.2.1.
#   Tailscale arrives on the tailscale0 interface (100.64.0.0/10).
#   Pods      10.0.0.0/8 is Cilium's cluster-pool. Pods must reach the node itself: the API server
#             (kubernetes.default -> node:6443), the kubelet (Prometheus scrapes node:10250), the
#             Cilium agent (Hubble Relay -> node:4244, health -> node:4240). Anything from a pod IP is
#             let in; pod IPs can't be spoofed from outside because they only exist on cilium_host/lxc.
# DHCP, loopback, ICMP and already-established connections are handled by ufw's own base rules.
#
# SAFETY. Always apply this with an automatic rollback armed (see docs/DEBUG.md Part 2 Phase Q):
#   sudo systemd-run --unit=gt-fw-rollback --on-active=420 /usr/sbin/ufw disable
# then confirm a NEW ssh connection works and `sudo systemctl stop gt-fw-rollback.timer`.
set -eu

LAN=192.0.2.0/24
PODS=10.0.0.0/8
TS=tailscale0

if [ "${1:-}" = "--dry-run" ]; then UFW="echo ufw"; else UFW="/usr/sbin/ufw"; fi

$UFW --force reset >/dev/null 2>&1 || true
$UFW default deny incoming
$UFW default allow outgoing
$UFW default deny routed       # same as the FORWARD policy the host already had; Cilium accepts pod traffic itself

# Remote administration
$UFW allow from $LAN to any port 22 proto tcp comment 'ssh from LAN'
$UFW allow in on $TS to any port 22 proto tcp comment 'ssh over Tailscale'

# The apps (hostPorts, see above)
for p in 3000 3001 9117; do
  $UFW allow from $LAN to any port $p proto tcp comment "app $p from LAN"
  $UFW allow in on $TS to any port $p proto tcp comment "app $p over Tailscale"
done

# Kubernetes API: only over Tailscale (from the node itself and from pods it is reached without these)
$UFW allow in on $TS to any port 6443 proto tcp comment 'k8s API over Tailscale'

# Pods -> the node (API server, kubelet, Cilium agent/health)
$UFW allow from $PODS comment 'pods to node'

# Tailscale direct (non-relayed) connections
$UFW allow 41641/udp comment 'tailscale direct'

$UFW logging low
$UFW --force enable
$UFW status verbose
