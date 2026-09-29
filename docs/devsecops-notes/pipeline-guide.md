# DevSecOps Pipeline — Full Project Guide

**GitLab CI + Ansible + kubeadm on Ubuntu Server 24.04**

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Repository Structure](#3-repository-structure)
4. [VM Specifications](#4-vm-specifications)
5. [Phase 1 — CI Pipeline Tutorial](#5-phase-1--ci-pipeline-tutorial)
6. [`.gitlab-ci.yml` Explained](#6-gitlab-ciyml-explained)
7. [Phase 2 — Ansible + Kubernetes Tutorial](#7-phase-2--ansible--kubernetes-tutorial)
8. [Ansible Roles — Full Code](#8-ansible-roles--full-code)
9. [Next Steps](#9-next-steps)

---

## 1. Project Overview

A complete DevSecOps loop: every commit is automatically tested through four security gates before it is allowed to deploy to a real Kubernetes cluster provisioned entirely by Ansible.

**Goal statement (for resume/interview):**
> "Security is built into the development workflow, not bolted on after. Every commit is blocked from deploying unless it passes four automated security gates: SAST, dependency scan, image scan, and DAST."

### Two-Phase Build Plan

| Phase | What | Status |
|---|---|---|
| **Phase 1** | GitLab CI pipeline — 4 security gates on free cloud runners | **Built.** `.gitlab-ci.yml` written, DVWA installed as the app under test. Not yet run against GitLab |
| **Phase 2** | Ansible provisions 2 Ubuntu Server VMs, installs Kubernetes via kubeadm, pipeline deploys to cluster | Roles written and idempotent. SSH access established. Playbook not yet run; `deploy` stage not yet wired |

### The application under test: DVWA

The pipeline scans **DVWA** (Damn Vulnerable Web Application, upstream
`digininja/DVWA`) — a PHP/MySQL app that is insecure by design. It sits in
`app/` and trips every gate, which is what makes the pipeline demonstrable
rather than a row of green checkmarks proving nothing.

Three things it changes versus a generic app:

- Serves on **port 80** (Apache), so `APP_PORT: "80"`.
- **Needs a database** — the DAST job runs MariaDB beside it on a private
  Docker network before scanning.
- Ships **its own Dockerfile** (`php:8-apache`), used as-is by the build stage.

> **The first run is deliberately report-only.** All three hard gates are set
> `allow_failure: true`. DVWA fails all of them, and a blocking failure in
> stage 1 would stop the pipeline before stages 2–5 ever produce reports. Flip
> the `# GATE:` lines to `false` once you have read all four.

### Where the project actually stands

| Piece | Exists? | What's needed |
|---|---|---|
| `.gitlab-ci.yml` | Yes | 5 stages, 5 jobs; gates report-only until triaged |
| `app/` (DVWA source) | Yes | 252 files; swap out later for your own app |
| `app/Dockerfile` | Yes | DVWA's own — `php:8-apache`, port 80 |
| `ansible/` roles | Yes, complete | Fill in real IPs in `inventory/hosts.ini` and run |
| SSH to target machine | Yes, working | — (§7 pre-requisite steps 4–6 already satisfied) |
| `k8s-manifests/deployment.yaml` | Yes (placeholder) | Real image reference once a registry is in play |
| `deploy` stage in CI | No | §9 — the last thing to build |

> **Note on §6 below:** the job definitions there are the original design. The
> file that now exists differs in three deliberate ways — Semgrep gained
> `--error` (without it, findings never fail the job), artifacts use
> `when: always` (so reports survive a failing gate), and build/image-scan are
> separate stages rather than one stage using `needs`. Read `.gitlab-ci.yml`
> as the source of truth.

---

## 2. Architecture

### Phase 1 — CI Pipeline Flow

```
commit / push to GitLab
        │
        ▼
  [Stage 1: SAST]
  Semgrep scans source code for insecure patterns
  → fails on HIGH/CRITICAL findings
        │
        ▼
  [Stage 2: Dependency Scan]
  Trivy (fs mode) scans package manifests for CVEs
  → fails on HIGH/CRITICAL CVEs
        │
        ▼
  [Stage 3: Build + Image Scan]
  Docker builds the image → Trivy scans its layers
  → fails on HIGH/CRITICAL CVEs in base image
        │
        ▼
  [Stage 4: DAST]
  ZAP baseline scan attacks the running container
  → starts warn-only, tightened after triage
        │
        ▼
  Reports (SARIF / JSON / HTML) uploaded as CI artifacts
```

### Phase 2 — Infrastructure Layout

```
Your machine (16 GB RAM)
├── VM1 — Ubuntu Server 24.04  (4 GB RAM, 2 vCPU, 30 GB)
│       └── kubeadm control plane + Calico CNI
└── VM2 — Ubuntu Server 24.04  (4 GB RAM, 2 vCPU, 30 GB)
        └── kubeadm worker node

Ansible (runs from your host / WSL2)
  → provisions both VMs
  → installs containerd + kubeadm on both
  → kubeadm init on VM1
  → kubeadm join on VM2

After all CI gates pass:
  → pipeline deploys k8s-manifests/ to the cluster
```

### Security Gate Summary

| Stage | Tool | What it catches | Fails build on |
|---|---|---|---|
| SAST | Semgrep | Insecure code patterns (OWASP Top 10) | HIGH / CRITICAL findings |
| Dependency scan | Trivy fs | Vulnerable libraries in package manifests | HIGH / CRITICAL CVEs |
| Image scan | Trivy image | Vulnerable OS packages in container layers | HIGH / CRITICAL CVEs |
| DAST | OWASP ZAP | Runtime web vulns (XSS, missing headers, etc.) | Warn-only at first |

---

## 3. Repository Structure

```
devsecops-pipeline/
│
├── .gitlab-ci.yml                  ← pipeline entry point, start here
│                                     (5 stages, 5 jobs — the live definition)
│
├── app/                            ← YOUR application goes here
│   ├── Dockerfile                  ← containerise your app
│   ├── src/                        ← your source code
│   └── requirements.txt            ← or package.json / go.mod
│       (Trivy dependency scan reads this file)
│
├── ansible/
│   ├── inventory/
│   │   └── hosts.ini               ← VM IPs + SSH user
│   ├── playbook.yml                ← master playbook, calls all roles in order
│   └── roles/
│       ├── common/                 ← runs on BOTH VMs
│       │   └── tasks/main.yml      ← swap off, containerd, kubeadm tools
│       ├── k8s-control-plane/      ← VM1 only
│       │   └── tasks/main.yml      ← kubeadm init, Calico, generates join token
│       └── k8s-worker/             ← VM2 only
│           └── tasks/main.yml      ← kubeadm join using token from VM1
│
├── k8s-manifests/
│   └── deployment.yaml             ← Deployment + Service (wired up in phase 2)
│
├── reports/                        ← gitignored locally, kept as CI artifacts
└── README.md
```

---

## 4. VM Specifications

### Recommended Specs

| | VM1 — Control Plane | VM2 — Worker Node |
|---|---|---|
| OS | Ubuntu Server 24.04 LTS | Ubuntu Server 24.04 LTS |
| RAM | 4 GB | 4 GB |
| CPU | 2 vCPU | 2 vCPU |
| Disk | 30 GB | 30 GB |
| Role | kubeadm init + Calico CNI | kubeadm join |
| Static IP (example) | 192.168.1.10 | 192.168.1.11 |

### RAM Budget on 16 GB Host

| Component | RAM |
|---|---|
| Host OS (Windows / Linux) | ~3–4 GB |
| VM1 — control plane | 4 GB |
| VM2 — worker node | 4 GB |
| IDE + browser | ~2 GB |
| **Total** | **~13–14 GB ✓** |

### Why Ubuntu Server 24.04 LTS

- **No desktop environment** — saves ~1 GB RAM per VM vs Ubuntu Desktop
- **kubeadm officially supports it** — no kernel module troubleshooting
- **OpenSSH pre-installed** — Ansible connects via SSH immediately, zero extra config
- **LTS until 2029** — won't break mid-project with random package updates

---

## 5. Phase 1 — CI Pipeline Tutorial

### Step 1: Create the GitLab Repo

```bash
# On gitlab.com → New Project → Create blank project
git clone <your-repo-url>
cd <your-repo>
# Copy the devsecops-pipeline scaffold into the repo root
```

### Step 1b: `.gitlab-ci.yml` — already written

This file now exists at the repo root. Its stage list and variables are below
for reference; the four job definitions are explained in
[§6](#6-gitlab-ciyml-explained). Note that `APP_PORT` is `80` because DVWA's
Apache serves there:

```yaml
stages:
  - sast
  - dependency-scan
  - build
  - image-scan
  - dast

variables:
  APP_DIR: "app"                      # DVWA source lives here
  APP_PORT: "80"                      # DVWA's Apache listens on 80
  IMAGE_NAME: "dvwa"
  IMAGE_TAG: "$CI_COMMIT_SHORT_SHA"
  DB_NAME: "dvwa"
  DB_USER: "dvwa"
  DB_PASS: "p@ssw0rd"
  DB_ROOT_PASS: "dvwa"
```

The three gate jobs are `allow_failure: true` for now so the first run gets you
all four reports instead of stopping at stage 1.

### Step 2: Add Your Application

Drop your app source code into `app/`. Replace `app/Dockerfile` with one matching your stack.

**Node.js example:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

**Python / Flask example:**
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 3000
CMD ["python", "app.py"]
```

Then update `APP_PORT` in `.gitlab-ci.yml` to match your app's port.

### Step 3: Push and Watch the Pipeline

```bash
git add .
git commit -m "initial pipeline"
git push
```

Go to **GitLab → CI/CD → Pipelines** to watch the 4 stages run. Reports are downloadable from each job once it finishes under the **Artifacts** section.

### Step 4: Tune the Gates

Start permissive, tighten after you understand the findings:

- **Semgrep & Trivy**: if flooded with false positives, temporarily set `allow_failure: true` in `.gitlab-ci.yml` while investigating, then flip back to `false`.
- **ZAP**: starts with `-I` flag (informational, does not fail the job) and `allow_failure: true`. After triaging findings, remove `-I` and set `allow_failure: false`.
- **Severity threshold**: currently `HIGH,CRITICAL`. Tighten to `MEDIUM,HIGH,CRITICAL` once your app is clean at the higher levels.

> **Tip:** Run the pipeline at least once with `allow_failure: true` on all jobs first so you can see the full picture before deciding thresholds.

---

## 6. `.gitlab-ci.yml` Explained

### Global variables

```yaml
variables:
  APP_DIR: "app"                # path to your source code
  APP_PORT: "3000"              # port your app listens on
  IMAGE_NAME: "myapp"
  IMAGE_TAG: "$CI_COMMIT_SHORT_SHA"   # unique tag per commit
```

### Stage 1 — SAST: Semgrep

```yaml
semgrep-sast:
  stage: sast
  image: semgrep/semgrep:latest
  script:
    - semgrep scan --config p/owasp-top-ten --config p/ci
        --sarif --output reports/semgrep.sarif "$APP_DIR"
  artifacts:
    paths: [reports/semgrep.sarif]
  allow_failure: false
```

- `p/owasp-top-ten` — covers SQL injection, XSS, path traversal, hardcoded secrets, etc.
- `p/ci` — adds sane CI defaults, ignores test files, reduces noise.
- `--sarif` — machine-readable output; GitLab can parse this natively for the Security dashboard.

### Stage 2 — Dependency Scan: Trivy (fs mode)

```yaml
trivy-dependency-scan:
  stage: dependency-scan
  image:
    name: aquasec/trivy:latest
    entrypoint: [""]
  script:
    - trivy fs --severity HIGH,CRITICAL --exit-code 1
        --format json --output reports/trivy-fs.json "$APP_DIR"
  artifacts:
    paths: [reports/trivy-fs.json]
  allow_failure: false
```

- Scans `package.json`, `requirements.txt`, `go.sum`, etc. for known CVEs.
- `--exit-code 1` makes Trivy return non-zero (fail the job) when findings exist.

### Stage 3 — Build + Image Scan: Docker + Trivy

```yaml
build-and-image-scan:       # job 1: build and save
  stage: build-and-image-scan
  image: docker:24.0
  services: [docker:24.0-dind]
  script:
    - docker build -t "$IMAGE_NAME:$IMAGE_TAG" "$APP_DIR"
    - docker save "$IMAGE_NAME:$IMAGE_TAG" -o image.tar
  artifacts:
    paths: [image.tar]      # passed to the next job via artifacts

trivy-image-scan:           # job 2: scan the saved image
  stage: build-and-image-scan
  needs: [build-and-image-scan]
  script:
    - trivy image --input image.tar --severity HIGH,CRITICAL --exit-code 1
        --format json --output reports/trivy-image.json
  allow_failure: false
```

- `image.tar` is passed between jobs via artifacts — avoids rebuilding the image.
- Scans base image OS packages (e.g. outdated `libssl` in alpine).

### Stage 4 — DAST: OWASP ZAP Baseline

```yaml
zap-dast:
  stage: dast
  image: docker:24.0
  services: [docker:24.0-dind]
  needs: [build-and-image-scan]
  script:
    - docker load -i image.tar
    - docker run -d --name target -p "$APP_PORT:$APP_PORT" "$IMAGE_NAME:$IMAGE_TAG"
    - sleep 15
    - docker run --network host -v "$(pwd)/reports:/zap/wrk/:rw"
        zaproxy/zap-stable zap-baseline.py
        -t "http://localhost:$APP_PORT"
        -r zap-report.html
        -J zap-report.json
        -I          # remove once tuned
  artifacts:
    paths: [reports/zap-report.html, reports/zap-report.json]
  allow_failure: true       # flip to false once tuned
```

- ZAP baseline scan takes ~2–5 minutes; catches missing security headers, XSS, open redirects, etc.
- `-I` = informational mode: reports findings but does not fail the job. Remove it when ready to enforce.
- Both HTML and JSON reports are uploaded as artifacts.

---

## 7. Phase 2 — Ansible + Kubernetes Tutorial

### Pre-requisites on Your Host Machine

```bash
# Install Ansible
sudo apt install ansible           # or: pip install ansible

# Verify
ansible --version
```

> **Already done:** SSH access to the target machine is working, so steps 4–6
> below are satisfied for it. They still apply to any *additional* VM you
> create — both nodes need key-based SSH and passwordless sudo before the
> playbook can run.

Then in VirtualBox / VMware:
1. Create 2 VMs from Ubuntu Server 24.04 LTS ISO.
2. Assign each: 4 GB RAM, 2 vCPU, 30 GB disk.
3. Set a static IP on each VM (edit `/etc/netplan/00-installer-config.yaml`).
4. Enable SSH on both VMs:

```bash
sudo systemctl enable --now ssh
```

5. Copy your SSH public key from your host to both VMs:

```bash
ssh-copy-id ubuntu@192.168.1.10
ssh-copy-id ubuntu@192.168.1.11
```

6. Allow passwordless sudo on both VMs:

```bash
echo 'ubuntu ALL=(ALL) NOPASSWD: ALL' | sudo tee /etc/sudoers.d/ubuntu
```

### Update `ansible/inventory/hosts.ini`

The file currently ships with placeholder addresses (`192.168.X.10` /
`192.168.X.11`) — replace the `X` with your real subnet before running
anything, or Ansible will fail to resolve the hosts.

```ini
[control_plane]
k8s-master ansible_host=192.168.1.10 ansible_user=ubuntu

[workers]
k8s-worker1 ansible_host=192.168.1.11 ansible_user=ubuntu

[k8s_cluster:children]
control_plane
workers

[k8s_cluster:vars]
ansible_python_interpreter=/usr/bin/python3
```

### Test Connectivity Before Running

```bash
cd ansible/
ansible -i inventory/hosts.ini k8s_cluster -m ping
```

Expected output:
```
k8s-master   | SUCCESS => { "ping": "pong" }
k8s-worker1  | SUCCESS => { "ping": "pong" }
```

### Run the Playbook

```bash
ansible-playbook -i inventory/hosts.ini playbook.yml
```

The playbook runs three plays in order:

1. **common** on both VMs — disables swap, loads kernel modules, installs containerd, kubeadm, kubelet, kubectl.
2. **k8s-control-plane** on VM1 — runs `kubeadm init`, installs Calico CNI, generates a join token and fetches it back to your machine.
3. **k8s-worker** on VM2 — copies the join token and runs `kubeadm join`.

### Verify the Cluster

```bash
# SSH into VM1
ssh ubuntu@192.168.1.10

kubectl get nodes
```

Expected output:
```
NAME          STATUS   ROLES           AGE   VERSION
k8s-master    Ready    control-plane   5m    v1.29.x
k8s-worker1   Ready    <none>          3m    v1.29.x
```

---

## 8. Ansible Roles — Full Code

### `ansible/playbook.yml`

```yaml
---
- name: Prepare all nodes
  hosts: k8s_cluster
  become: true
  roles:
    - common

- name: Initialise control plane
  hosts: control_plane
  become: true
  roles:
    - k8s-control-plane

- name: Join worker nodes
  hosts: workers
  become: true
  roles:
    - k8s-worker
```

---

### `roles/common/tasks/main.yml` — Both VMs

```yaml
---
- name: Disable swap immediately
  command: swapoff -a
  changed_when: false

- name: Remove swap entry from /etc/fstab
  replace:
    path: /etc/fstab
    regexp: '^([^#].*\sswap\s.*)$'
    replace: '# \1'

- name: Load required kernel modules
  modprobe:
    name: "{{ item }}"
    state: present
  loop:
    - overlay
    - br_netfilter

- name: Persist kernel modules across reboots
  copy:
    dest: /etc/modules-load.d/k8s.conf
    content: |
      overlay
      br_netfilter
    mode: '0644'

- name: Set sysctl parameters for Kubernetes networking
  sysctl:
    name: "{{ item.key }}"
    value: "{{ item.value }}"
    sysctl_set: true
    state: present
    reload: true
  loop:
    - { key: net.bridge.bridge-nf-call-iptables,  value: "1" }
    - { key: net.bridge.bridge-nf-call-ip6tables, value: "1" }
    - { key: net.ipv4.ip_forward,                 value: "1" }

- name: Install prerequisite packages
  apt:
    name:
      - apt-transport-https
      - ca-certificates
      - curl
      - gnupg
      - lsb-release
    state: present
    update_cache: true

# ── containerd ──────────────────────────────────────────────────────────────

- name: Add Docker GPG key
  apt_key:
    url: https://download.docker.com/linux/ubuntu/gpg
    state: present

- name: Add Docker apt repository
  apt_repository:
    repo: "deb [arch=amd64] https://download.docker.com/linux/ubuntu {{ ansible_distribution_release }} stable"
    state: present

- name: Install containerd
  apt:
    name: containerd.io
    state: present
    update_cache: true

- name: Generate default containerd config
  shell: containerd config default > /etc/containerd/config.toml
  args:
    creates: /etc/containerd/config.toml

- name: Set SystemdCgroup = true in containerd config
  replace:
    path: /etc/containerd/config.toml
    regexp: 'SystemdCgroup = false'
    replace: 'SystemdCgroup = true'

- name: Enable and restart containerd
  systemd:
    name: containerd
    enabled: true
    state: restarted

# ── kubeadm / kubelet / kubectl ─────────────────────────────────────────────

- name: Add Kubernetes GPG key
  apt_key:
    url: https://pkgs.k8s.io/core:/stable:/v1.29/deb/Release.key
    state: present

- name: Add Kubernetes apt repository
  apt_repository:
    repo: "deb https://pkgs.k8s.io/core:/stable:/v1.29/deb/ /"
    state: present
    filename: kubernetes

- name: Install kubeadm, kubelet, kubectl
  apt:
    name:
      - kubeadm=1.29.*
      - kubelet=1.29.*
      - kubectl=1.29.*
    state: present
    update_cache: true

- name: Hold versions (prevent auto-upgrade)
  dpkg_selections:
    name: "{{ item }}"
    selection: hold
  loop:
    - kubeadm
    - kubelet
    - kubectl

- name: Enable kubelet service
  systemd:
    name: kubelet
    enabled: true
    state: started
```

---

### `roles/k8s-control-plane/tasks/main.yml` — VM1 only

```yaml
---
- name: Check if kubeadm has already been initialised
  stat:
    path: /etc/kubernetes/admin.conf
  register: kubeadm_init_done

- name: Run kubeadm init
  command: >
    kubeadm init
      --pod-network-cidr=192.168.0.0/16
      --apiserver-advertise-address={{ ansible_default_ipv4.address }}
  when: not kubeadm_init_done.stat.exists
  register: kubeadm_init_output

- name: Create .kube directory for the ansible user
  file:
    path: "/home/{{ ansible_user }}/.kube"
    state: directory
    owner: "{{ ansible_user }}"
    group: "{{ ansible_user }}"
    mode: '0755'

- name: Copy admin.conf to ansible user's .kube/config
  copy:
    src: /etc/kubernetes/admin.conf
    dest: "/home/{{ ansible_user }}/.kube/config"
    remote_src: true
    owner: "{{ ansible_user }}"
    group: "{{ ansible_user }}"
    mode: '0600'

# ── Calico CNI ──────────────────────────────────────────────────────────────
# pod-network-cidr must be 192.168.0.0/16 for Calico (set above).
# For Flannel instead: change cidr to 10.244.0.0/16 and apply:
#   https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml

- name: Install Calico operator
  become: false
  command: >
    kubectl apply -f
    https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/tigera-operator.yaml
  environment:
    KUBECONFIG: "/home/{{ ansible_user }}/.kube/config"

- name: Install Calico custom resources
  become: false
  command: >
    kubectl apply -f
    https://raw.githubusercontent.com/projectcalico/calico/v3.27.0/manifests/custom-resources.yaml
  environment:
    KUBECONFIG: "/home/{{ ansible_user }}/.kube/config"

- name: Wait for control-plane node to be Ready
  become: false
  command: kubectl get nodes
  register: nodes_status
  retries: 20
  delay: 15
  until: "'NotReady' not in nodes_status.stdout"
  environment:
    KUBECONFIG: "/home/{{ ansible_user }}/.kube/config"

# ── Generate join command for workers ───────────────────────────────────────

- name: Generate kubeadm join command
  command: kubeadm token create --print-join-command
  register: join_command_output

- name: Save join command on control plane
  copy:
    content: "{{ join_command_output.stdout }}"
    dest: /tmp/kubeadm_join_command.sh
    mode: '0600'

- name: Fetch join command back to Ansible control machine
  fetch:
    src: /tmp/kubeadm_join_command.sh
    dest: /tmp/kubeadm_join_command.sh
    flat: true
```

---

### `roles/k8s-worker/tasks/main.yml` — VM2 only

```yaml
---
- name: Check if node has already joined a cluster
  stat:
    path: /etc/kubernetes/kubelet.conf
  register: already_joined

- name: Copy join command from Ansible control machine to worker
  copy:
    src: /tmp/kubeadm_join_command.sh
    dest: /tmp/kubeadm_join_command.sh
    mode: '0700'
  when: not already_joined.stat.exists

- name: Run kubeadm join
  command: bash /tmp/kubeadm_join_command.sh
  when: not already_joined.stat.exists

- name: Clean up join command file
  file:
    path: /tmp/kubeadm_join_command.sh
    state: absent
```

---

## 9. Next Steps

In dependency order — each item needs the one above it:

1. ~~Create `.gitlab-ci.yml`~~ — **done.**
2. ~~Put an application in `app/`~~ — **done**, DVWA is installed.
3. **Push to GitLab and watch the first run.** All five jobs should complete;
   the three gates show orange (passed-with-warnings) because they are
   report-only. Still no VMs needed at this point.
4. **Read all four reports**, then flip the `# GATE:` lines in
   `.gitlab-ci.yml` to `allow_failure: false` so the pipeline blocks.
5. **Fill real IPs into `ansible/inventory/hosts.ini`** and run the playbook
   against your two VMs. SSH access is already in place.
5. **Push the image to a registry** (GitLab Container Registry is free) so the
   cluster can pull it, and replace `REGISTRY/myapp:TAG` in
   `k8s-manifests/deployment.yaml`.
6. **Add a deploy stage** to `.gitlab-ci.yml` running
   `kubectl apply -f k8s-manifests/` after all 4 gates pass — this is the step
   that finally connects Phase 1 to Phase 2.
7. **Add observability** — Prometheus + Grafana on the cluster.
8. **Finish the README** with the architecture diagram and screenshots of the
   scan reports — this is what you open in interviews.

> **Your immediate next action:** create `.gitlab-ci.yml` at the repo root from
> the definitions in §6. Everything else in Phase 1 is already scaffolded and
> waiting on it.
