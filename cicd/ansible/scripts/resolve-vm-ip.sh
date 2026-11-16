#!/usr/bin/env bash
# Resolves a VM's *current* IP from VMware Workstation/Player's own DHCP
# lease file, by MAC address, instead of a hardcoded IP in inventory.
#
# Why this exists: kan2server sits on VMware's NAT network (vmnet8) with a
# normal DHCP lease (30 min) — it keeps the same IP while it stays up
# (renews in place), but gets a new one if it's down across a lease expiry
# (confirmed happening in practice: <vm-ip> -> .151 after one such
# gap). A hardcoded ansible_host breaks every time that happens. The VM's
# MAC address never changes, so resolving IP-by-MAC at playbook run time
# (via host_vars/kan2server.yml) fixes this without touching the VM's own
# network config (that would be the other real fix — a DHCP reservation —
# but that's a VMware host-level/service-restart change, done separately
# and deliberately, not bundled into this).
#
# Usage: resolve-vm-ip.sh <mac-address>
# Prints the IP to stdout, exits non-zero with a message on stderr if not found.
set -euo pipefail

mac="${1:?usage: resolve-vm-ip.sh <mac-address>}"

# Default: VMware Workstation's lease file as seen from WSL. Override with
# VM_LEASE_FILE if running this from somewhere else (e.g. VMware Player's
# path differs slightly, or a non-WSL Linux control node with the file
# shared another way).
leases_file="${VM_LEASE_FILE:-/mnt/c/ProgramData/VMware/vmnetdhcp.leases}"

if [[ ! -r "$leases_file" ]]; then
  echo "resolve-vm-ip.sh: can't read lease file at $leases_file (set VM_LEASE_FILE to override)" >&2
  exit 1
fi

# ISC dhcpd-style lease files are append-only — every renewal adds a new
# `lease <ip> { ... }` block rather than rewriting the old one. So the
# LAST block in the file for this MAC is the current/active lease; this
# also comes for free once a VM's IP itself changes between leases.
ip="$(awk -v mac="$mac" '
  /^lease / { ip = $2; in_block = 1; matched = 0; next }
  in_block && $0 ~ ("hardware ethernet " mac ";") { matched = 1 }
  in_block && /^}/ { if (matched) last_ip = ip; in_block = 0 }
  END { if (last_ip != "") print last_ip }
' "$leases_file")"

if [[ -z "$ip" ]]; then
  echo "resolve-vm-ip.sh: no lease found for MAC $mac in $leases_file" >&2
  exit 1
fi

echo "$ip"
