# DevSecOps Pipeline — Step-by-Step Follow-Along Tutorial

> **This file is the one you follow.** It is the checklist — do the steps in order, top to bottom.
>
> `Project CICD/devsecops-pipeline-guide.md` is the *reference* (why things work, background).
> Where the two disagree, **this file wins** — the guide's section 8 Ansible code breaks on
> Ubuntu 24.04+ (removed `apt-key`, containerd ships with CRI disabled, Calico `kubectl apply`
> size bug) and pins Kubernetes 1.29, which is EOL.
>
> **You're on Windows 11.** Everything happens inside **WSL2** — git, glab, and Ansible all live
> in one Linux environment. PowerShell is used exactly once, to install WSL.

---

## 📍 Where you are right now

Work already completed and sitting on your D: drive at
`D:\STUDY\Sem alone\Project CICD\devsecops-pipeline\devsecops-pipeline\`:

| Piece | State |
|---|---|
| `.gitlab-ci.yml` | ✅ Written — 5 stages, 5 jobs, gates report-only for the first run |
| `app/` (DVWA source) | ✅ 252 files from upstream `digininja/DVWA` |
| `app/Dockerfile` | ✅ DVWA's own — `php:8-apache`, serves on port 80 |
| `.gitignore` + `reports/.gitkeep` | ✅ Created |
| `README.md` | ✅ Up to date |
| `ansible/` roles | ⚠️ **STALE** — still the broken 1.29/`apt_key` version. **Step C5 overwrites them.** |
| git repo | ❌ Not initialised yet — that's step B2 |
| VMs / cluster | ❌ Not built yet — Part C |

**Your next action: Part 0, then B1.**

---

## Legend — where do I run each command?

| Tag | Means | How to open |
|---|---|---|
| 🪟 **PowerShell** | Windows PowerShell on your host — used ONCE, to install WSL | `Win` → type "PowerShell" |
| 🐧 **WSL2** | Ubuntu inside Windows — your main workspace for the whole project | `wsl` in PowerShell |
| 🖥️ **VM1 / VM2** | Inside a VM over SSH | via `ssh` from WSL2 |

> **Golden rule:** work inside your **WSL home** (`~/devsecops-pipeline`), **not** `/mnt/d/...`.
> Files on `/mnt/d` have Windows permissions that SSH keys and Ansible reject outright
> (`UNPROTECTED PRIVATE KEY FILE`). The D: copy stays as your backup; WSL home is where you work.

---

# PART 0 — Your settings (fill in once)

Every later step reads these, so you never retype an IP or username — and the tutorial can't
drift out of sync with itself.

### 0a. Find your real values first 🖥️ on each VM

On each VM console, run:
```bash
ip a | grep "inet "        # your VM's IP
whoami                     # your VM's login username
```

> **Note:** earlier drafts of this file mixed up several usernames and two different
> subnets. Whatever `whoami` and `ip a` print above is the truth — use those.

### 0b. Save them 🐧 WSL2

```bash
cat > ~/.devsecops-env <<'EOF'
# ---- EDIT THESE FOUR LINES ----
export VM1_IP="<vm1-ip>"      # control plane
export VM2_IP="<vm-ip>"      # worker
export VM1_USER="<vm1-user>"              # from `whoami` on VM1
export VM2_USER="<vm2-user>"            # from `whoami` on VM2
# -------------------------------
EOF

echo 'source ~/.devsecops-env' >> ~/.bashrc
source ~/.devsecops-env
echo "VM1=$VM1_USER@$VM1_IP   VM2=$VM2_USER@$VM2_IP"
```

**✅ Checkpoint:** that last line prints your two VMs correctly.

---

# PART A — One-Time Setup

### A1. Install WSL2 + Ubuntu 🪟 PowerShell (as Admin)

```powershell
wsl --install -d Ubuntu
```
Reboot if asked, then set a UNIX username/password when Ubuntu first launches.

Verify, then **open Ubuntu** — everything from here on is inside WSL:
```powershell
wsl -l -v      # VERSION must be 2
```

### A2. Install git + glab inside WSL 🐧 WSL2

```bash
sudo apt update
sudo apt install -y git curl
sudo snap install glab
git --version && glab --version
```

### A3. Create a GitLab token 🌐 browser

You need a token before `glab` can log in. GitLab now offers **two different kinds**, on two
different pages, and they look nothing alike — this trips people up constantly.

| | **Classic PAT** ← use this | **Fine-grained token** |
|---|---|---|
| Page title | "Add a personal access token" | "Generate fine-grained token" |
| URL | `/-/user_settings/personal_access_tokens` | `.../personal_access_tokens/granular/new` |
| How you pick access | A short list of **scope checkboxes** (`api`, `write_repository`, …) | A resource tree — pick each resource, then its permissions |
| Status | Long-standing | GA since GitLab 19.2 (beta in 18.10) |
| Works with `glab` | Yes, this is what glab expects | Works, but GitLab's docs don't map every endpoint to its permission — you discover gaps as 403s |

**Use the classic PAT.** The fine-grained flow is documented below in case you're already on
that page or your admin requires it.

#### A3a. Classic PAT (recommended)

1. Go to **https://gitlab.com/-/user_settings/personal_access_tokens**
   (or: your avatar, top-right → **Edit profile** → left sidebar **Access → Personal access
   tokens**).
2. Click **Add new token**.
3. Fill in:
   - **Token name** → `devsecops-pipeline`
   - **Expiration date** → GitLab caps this at **365 days**. Leave the default or set your own;
     you cannot exceed the cap.
4. Tick **one** scope:
   - ☑ **`api`** — this is all you need. GitLab's docs: *"Grants complete read and write access
     to the API for the token's scope. Includes the container registry, the dependency proxy,
     and the package registry."* **For personal access tokens, `api` also includes
     Git-over-HTTP repository access** — so it covers `git clone`/`git push` too.
   - Leave everything else unticked. In particular `write_repository` is **redundant** here: it
     grants the same git pull/push but *"does not support API authentication"*, so it can't
     replace `api` — and adds nothing once `api` is ticked.
   - Never tick `sudo` or `admin_mode`.

   > `api` is broad — it can reach everything your account can. That's the trade for the
   > classic token's simplicity. If that bothers you, use the fine-grained token (A3b), which
   > exists precisely to narrow this.
5. Click **Create personal access token**.
6. **Copy the token immediately** — it starts with `glpat-` and is shown **exactly once**. If you
   navigate away without copying, you must delete it and make a new one.

#### A3b. Fine-grained token (only if you must)

If you're on the **"Generate fine-grained token"** page, here's how to fill it in:

1. **Basic Information**
   - **Name** → `devsecops-pipeline`
   - **Description** → optional
   - **Expiration date** → capped at 365 days, same as above
2. **Group and project access** — choose **"Only my personal projects"**. Your pipeline repo
   lives under your own username, so the broader options grant access you don't need.
3. **Add resource permissions** — keep the **"Group and project"** tab selected. Expand a
   category with the **›** chevron, or use the search box, and tick exactly these five:

   | Tab | Category | Resource | Permissions to tick | Why |
   |---|---|---|---|---|
   | Group and project | CI/CD | **Pipeline** | `read` | Watch runs (`glab ci status`) |
   | Group and project | CI/CD | **Job** | `read` | Read job results |
   | Group and project | CI/CD | **Job Artifact** | `read` (+ `download` if offered) | Pull the scan reports |
   | Group and project | Projects | **Project** | `create`, `read` | `glab repo create`, read the project |
   | Group and project | Repository | **Code** | `download`, `push`, `read` | This *is* your git clone/push access |
   | **User** | — | **User** | `read` | **Required.** glab's first API call is `GET /api/v4/user`; without this every command dies with `403 insufficient_granular_scope` |

   Leave the rest of each resource's actions unticked. **Project** in particular also offers
   `archive`, `delete`, `fork`, `share`, `transfer` and `update` — none are needed.

   > ⚠️ **Do not tick the category checkbox** (the box beside "Repository", "CI/CD", …). That is
   > a select-all and pulls in ~26 resources, including **Repository History** (rewrite git
   > history), **Merge Request** (approve/merge/delete), **Protected Branch** and **Push Rule**
   > (weaken your own branch protections). None of that is needed to push code and read a
   > pipeline. Tick the individual resources instead.

   > Search returns near-matches — pick the exact name. "Project", not "Pipeline Execution
   > Project Schedule"; "Job", not "Job Token Scope".

4. Each ticked resource appears in the **right-hand panel** (it starts out saying *"No resources
   selected"*). Set its permission there: **read + write/create** on Code and Project, **read**
   is enough for Pipeline, Job and Job Artifact.
5. Leave the **Global** tab empty. The **User** tab needs exactly one entry — **User → `read`**
   (see the table above); everything else there stays off.
6. Click **Generate token** and copy the `glpat-…` value immediately.

> **Fine-grained tokens cannot be edited after creation.** If you miss a permission, you must
> generate a replacement and revoke the old one. This is the main reason the classic PAT (A3a)
> is less painful.
>
> **Why permissions are hard to get right first time:** GitLab's REST permissions reference
> documents some endpoint→permission mappings (Pipeline → Read, Job Artifact → Read) but
> **not** others — `GET /user` and `POST /projects` are absent, and git-over-HTTPS sits in a
> separate "Git and other permissions" category with no endpoint table. The table above was
> assembled from the resource descriptions in the UI plus the 403 errors themselves, not from
> a published mapping.

> **If `git push` is rejected while creating the branch**, add **Branch** (Repository category)
> and retry — that is the one permission whose boundary with Code's "push" is unclear.

> If `glab` later fails with a 403 on a command that should work, the fine-grained token is the
> likely cause — delete it and use a classic PAT instead (A3a).

### A3c. Log glab in 🐧 WSL2

```bash
glab auth login
```

Answer the prompts:
- **What GitLab instance do you want to log into?** → `GitLab.com`
- **How would you like to login?** → `Token`
- **Paste your authentication token** → paste the `glpat-…` value. **Nothing appears as you
  paste — that's intentional**, the input is hidden. Press Enter.
- **What domains does this host use for the container registry and image dependency proxy?**
  → press **Enter** to accept the pre-filled
  `gitlab.com,gitlab.com:443,registry.gitlab.com`. That's correct for gitlab.com, and it is the
  registry you push the image to in Part D. Only change it on a self-hosted instance.
- **Choose default git protocol** → `HTTPS`
- **Authenticate Git with your GitLab credentials?** → `Yes`

Make git reuse that same login so pushes never prompt you:
```bash
git config --global credential.helper '!glab auth git-credential'
```

Set your git identity (yours is already configured — shown for reference):
```bash
git config --global user.name  "Kan2nd"
git config --global user.email "kannguyen3105@gmail.com"
```

**✅ Checkpoint:**
```bash
glab auth status
```
should print `gitlab.com ✓ Logged in to gitlab.com as kannguyen3105` and
`✓ Token: **************************`.

> **🔒 Token hygiene**
> - `glab auth login` stores the token in `~/.config/glab-cli/config.yml`. You never need to
>   write it anywhere else.
> - **Never paste a token into a file inside the repo** — one `git push` and it's leaked
>   publicly. GitLab auto-revokes tokens it detects in pushed code, but assume it's burned.
> - You have a `Gitlab token.docx` in `D:\STUDY\Sem alone\`. That's one folder *above* the repo,
>   so it won't be committed — keep it that way, and never copy it into `~/devsecops-pipeline`.
> - To revoke or rotate: **https://gitlab.com/-/user_settings/personal_access_tokens** → find the
>   token → **Revoke**.

---

# PART B — PHASE 1: The CI Security Pipeline

**No VMs needed.** Everything runs on GitLab's free cloud runners.

### B1. Create the GitLab project 🐧 WSL2

```bash
glab repo create devsecops-pipeline --private --description "DevSecOps CI pipeline with 4 security gates"
```

> Or via web UI: gitlab.com → **New Project** → **Create blank project** → name it
> `devsecops-pipeline` → **uncheck** "Initialize repository with a README" → Create.

### B2. Copy your existing work into WSL home 🐧 WSL2

The pipeline, DVWA and configs already exist on D:. Bring them across, then work only in WSL.

```bash
cp -r "/mnt/d/STUDY/Sem alone/Project CICD/devsecops-pipeline/devsecops-pipeline" ~/devsecops-pipeline
cd ~/devsecops-pipeline
ls -a                     # expect: .gitlab-ci.yml .gitignore README.md ansible app k8s-manifests reports
```

Initialise git and connect it to the project you just created:
```bash
  git init -b main
  git remote add origin https://gitlab.com/kannguyen3105/devsecops-pipeline.git
```

> **Why copy instead of working on D: directly?** See the golden rule above — Ansible's SSH keys
> will not work from `/mnt/d`. The D: folder remains your untouched backup.

### B3. Understand what's already in the pipeline 🐧 WSL2

`.gitlab-ci.yml` is already written. **Read it rather than retyping it** — this tutorial
deliberately does not duplicate the YAML, because a copy in a doc always drifts out of sync
with the real file (that exact bug is why the old guide's §6 was wrong).

```bash
less .gitlab-ci.yml       # q to quit
```

What it does, stage by stage:

| Stage | Job | Tool | Active? | On DVWA, expect |
|---|---|---|---|---|
| `sast` | `semgrep-sast` | Semgrep | ✅ **runs** | **Lots** — SQLi, XSS, command injection in the PHP |
| `dependency-scan` | `.trivy-dependency-scan` | Trivy fs | ⏸ disabled | Light — DVWA has few pinned deps. Quiet is normal |
| `build` | `.build-image` | Docker | ⏸ disabled | Builds DVWA from `app/Dockerfile`, saves `image.tar` |
| `image-scan` | `.trivy-image-scan` | Trivy image | ⏸ disabled | **Lots** — CVEs in the `php:8-apache` base |
| `dast` | `.zap-dast` | OWASP ZAP | ⏸ disabled | **Lots** — missing headers, cookie flags, XSS |

Three things worth knowing before the first run:

1. **Only SAST runs right now.** The other four job names start with a `.`, which is GitLab's
   "hidden job" syntax — parsed but never executed. Nothing was deleted. This keeps a run at
   1–2 minutes instead of 10–15, which matters against the free tier's **400 CI minutes/month**.
   **To re-enable:** delete the leading `.`, in this order —
   `.trivy-dependency-scan` → `.build-image` → `.trivy-image-scan` → `.zap-dast`.
   Image-scan and DAST both consume `build-image`'s `image.tar`, so neither works without it.
2. **The gates are `allow_failure: true` on purpose.** DVWA fails them by design; report-only
   keeps the pipeline green while you read the findings. You tighten in B6.
3. **When you do re-enable DAST**, it stands up a MariaDB container beside DVWA (DVWA won't
   render without a database), and its `sleep` values may need tuning on shared runners.

### B4. Push and trigger the pipeline 🐧 WSL2

```bash
git add .
git commit -m "DevSecOps pipeline with DVWA as target application"
git push -u origin main
```

### B5. Watch it run 🐧 WSL2

```bash
glab ci status      # live status in the terminal
glab ci view        # open the pipeline in a browser
```

Or: **GitLab → Build → Pipelines**. Budget **10–15 minutes** — `zap-dast` alone sleeps ~50s for
the database and app to boot, then ZAP takes a few minutes.

**✅ Checkpoint:** `semgrep-sast` completes in 1–2 minutes and shows **orange** (passed with
warnings). Orange is success here — it means the gate found real problems in DVWA but isn't
blocking yet. The other four jobs won't appear at all; they're disabled (see B3).

### B6. Read the reports — this is the actual deliverable 🐧 WSL2

Each job → **Job artifacts → Download**, or:
```bash
glab ci artifact main zap-dast        # download a job's artifacts
```

| File | Available now? | Read it how |
|---|---|---|
| `reports/semgrep.sarif` | ✅ yes | JSON/SARIF — skim in VS Code, or upload to GitLab's Security tab |
| `reports/trivy-fs.json` | after re-enabling | JSON — dependency CVEs |
| `reports/trivy-image.json` | after re-enabling | JSON — base-image CVEs |
| `reports/zap-report.html` | after re-enabling | The only one built for human eyes — open in a browser |

**Screenshot these.** They are the evidence you show in an interview.

### B7. Tighten the gates 🐧 WSL2

Now make it enforce. In `.gitlab-ci.yml`:

1. Change the three lines marked `# GATE:` from `allow_failure: true` → `false`
   (`semgrep-sast`, `trivy-dependency-scan`, `trivy-image-scan`).
2. For **ZAP** (do this last, it's noisiest): remove the `-I` flag **and** set
   `allow_failure: false`.
3. Too noisy? Loosen selectively rather than switching gates off — raise Semgrep's
   `--severity` threshold, or keep Trivy at `HIGH,CRITICAL` instead of adding `MEDIUM`.

```bash
git add .gitlab-ci.yml
git commit -m "enforce security gates"
git push
```

**✅ Phase 1 done.** The pipeline now fails — deliberately. Your commit history showing
report-only → enforcing is the story worth telling.

> **If the build proves flaky** (composer/network timeouts building DVWA from source), swap to
> the prebuilt single-container image: replace `app/Dockerfile` with the one line
> `FROM vulnerables/web-dvwa:latest`, and delete the MariaDB steps from `zap-dast` (that image
> bundles its own database). Trade-off: the image is old and unmaintained, so the source you
> scan is no longer the code that runs — worth mentioning if an interviewer asks.

---

# PART C — PHASE 2: VMs, Ansible & Kubernetes

> **Superseded:** the `devsecops-pipeline` repo dropped Kubernetes — it was
> more than the project needed, and the target VM is meant to become a plain
> Docker + Compose + Portainer homelab box, not a kubeadm cluster. `ansible/`
> in that repo now just installs Docker Engine + Compose. The k8s steps below
> are kept as personal reference/study notes on kubeadm + Calico, not as the
> live setup procedure — see that repo's README for what's actually current.

Ansible runs **from WSL2**, targeting your two VMs over SSH.

## C1. Prepare each VM

First contact, using password login (keys come next):

🐧 WSL2:
```bash
ssh $VM1_USER@$VM1_IP
ssh $VM2_USER@$VM2_IP
```

### C1a. Set a static IP (recommended) 🖥️ on each VM

On Ubuntu Server 24.04+ the netplan file is usually `50-cloud-init.yaml`, not the old
`00-installer-config.yaml`:
```bash
ls /etc/netplan/
sudo nano /etc/netplan/50-cloud-init.yaml
```
Adapt the interface name from `ip a` (e.g. `enp0s3`), and keep the addresses on **your actual
subnet** — if your VMs are on e.g. `10.0.5.x`, do not paste `192.168.1.x`:
```yaml
network:
  version: 2
  ethernets:
    enp0s3:
      dhcp4: no
      addresses: [<vm1-ip>/24]     # VM2: <vm2-ip>
      routes:
        - to: default
          via: <gateway-ip>              # your gateway — check with `ip route`
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
```
Stop cloud-init from reverting it, fix permissions, apply:
```bash
echo 'network: {config: disabled}' | sudo tee /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg
sudo chmod 600 /etc/netplan/*.yaml
sudo netplan apply
```
> If you were SSH'd in on the old IP, the connection drops — reconnect on the new one.

### C1b. Ensure SSH is running 🖥️ on each VM

```bash
sudo systemctl enable --now ssh
sudo systemctl status ssh --no-pager
```

### C1c. Allow passwordless sudo 🖥️ on each VM

Use **your own username**, not a hardcoded `ubuntu`:
```bash
echo "$(whoami) ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/$(whoami)
```
Then `exit` back to WSL.

## C2. SSH keys from WSL2 🐧 WSL2

```bash
ls ~/.ssh/id_ed25519.pub 2>/dev/null || ssh-keygen -t ed25519 -C "ansible" -N "" -f ~/.ssh/id_ed25519

ssh-copy-id $VM1_USER@$VM1_IP
ssh-copy-id $VM2_USER@$VM2_IP

ssh $VM1_USER@$VM1_IP "hostname && echo OK"
ssh $VM2_USER@$VM2_IP "hostname && echo OK"
```

**✅ Checkpoint:** both print hostname + `OK` **without** asking for a password.

## C3. Install Ansible 🐧 WSL2

```bash
sudo apt update && sudo apt install -y ansible
ansible --version
```

## C4. Write the inventory 🐧 WSL2

Generated from your Part 0 settings so the IPs can't disagree with the rest of the tutorial:

```bash
cd ~/devsecops-pipeline/ansible
mkdir -p inventory
cat > inventory/hosts.ini <<EOF
[control_plane]
k8s-master ansible_host=$VM1_IP ansible_user=$VM1_USER

[workers]
k8s-worker1 ansible_host=$VM2_IP ansible_user=$VM2_USER

[k8s_cluster:children]
control_plane
workers

[k8s_cluster:vars]
ansible_python_interpreter=/usr/bin/python3
EOF
cat inventory/hosts.ini
```

## C5. Replace the stale Ansible roles 🐧 WSL2

> ⚠️ **The `ansible/roles/` files you copied from D: are the broken version** — they use the
> removed `apt_key` module, pin EOL Kubernetes 1.29, install Calico 3.27 with `kubectl apply`,
> and set a pod CIDR of `192.168.0.0/16` that collides with your LAN. **The code below replaces
> them.** Targets Ubuntu 24.04/26.04, **Kubernetes 1.34**, **Calico 3.32**.

### `ansible/playbook.yml`

```bash
cd ~/devsecops-pipeline/ansible
cat > playbook.yml <<'EOF'
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
EOF
```

### `ansible/roles/common/tasks/main.yml` — both VMs

```bash
mkdir -p roles/common/tasks
cat > roles/common/tasks/main.yml <<'EOF'
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
    state: present
    update_cache: true

- name: Create apt keyrings directory
  file:
    path: /etc/apt/keyrings
    state: directory
    mode: '0755'

# ── containerd (from Ubuntu's own repo — no third-party repo needed) ──────

- name: Install containerd
  apt:
    name: containerd
    state: present
    update_cache: true

- name: Ensure /etc/containerd exists
  file:
    path: /etc/containerd
    state: directory
    mode: '0755'

# Always regenerate — the packaged config ships with the CRI plugin disabled,
# which makes kubeadm fail with "container runtime is not running".
- name: Generate default containerd config
  shell: containerd config default > /etc/containerd/config.toml

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

# ── kubeadm / kubelet / kubectl (Kubernetes 1.34) ─────────────────────────

- name: Download Kubernetes apt signing key
  get_url:
    url: https://pkgs.k8s.io/core:/stable:/v1.34/deb/Release.key
    dest: /etc/apt/keyrings/kubernetes-apt-keyring.asc
    mode: '0644'

- name: Add Kubernetes apt repository
  apt_repository:
    repo: "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.asc] https://pkgs.k8s.io/core:/stable:/v1.34/deb/ /"
    state: present
    filename: kubernetes

- name: Install kubeadm, kubelet, kubectl
  apt:
    name:
      - kubeadm
      - kubelet
      - kubectl
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
EOF
```

### `ansible/roles/k8s-control-plane/tasks/main.yml` — VM1 only

```bash
mkdir -p roles/k8s-control-plane/tasks
cat > roles/k8s-control-plane/tasks/main.yml <<'EOF'
---
- name: Check if kubeadm has already been initialised
  stat:
    path: /etc/kubernetes/admin.conf
  register: kubeadm_init_done

# Pod CIDR 10.244.0.0/16 — deliberately NOT 192.168.0.0/16, which would
# overlap the LAN the VMs live on.
- name: Run kubeadm init
  command: >
    kubeadm init
      --pod-network-cidr=10.244.0.0/16
      --apiserver-advertise-address={{ ansible_default_ipv4.address }}
  when: not kubeadm_init_done.stat.exists

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

# ── Calico CNI v3.32 ──────────────────────────────────────────────────────
# `kubectl create`, not `apply` — the operator manifest's CRDs exceed the size
# limit of apply's last-applied-configuration annotation.

- name: Install Calico operator
  become: false
  command: >
    kubectl create -f
    https://raw.githubusercontent.com/projectcalico/calico/v3.32.1/manifests/tigera-operator.yaml
  register: calico_operator
  failed_when: calico_operator.rc != 0 and 'AlreadyExists' not in calico_operator.stderr
  changed_when: calico_operator.rc == 0
  environment:
    KUBECONFIG: "/home/{{ ansible_user }}/.kube/config"

- name: Download Calico custom resources
  become: false
  get_url:
    url: https://raw.githubusercontent.com/projectcalico/calico/v3.32.1/manifests/custom-resources.yaml
    dest: /tmp/calico-custom-resources.yaml
    mode: '0644'

- name: Match Calico pod CIDR to kubeadm (10.244.0.0/16)
  become: false
  replace:
    path: /tmp/calico-custom-resources.yaml
    regexp: '192\.168\.0\.0/16'
    replace: '10.244.0.0/16'

- name: Apply Calico custom resources
  become: false
  command: kubectl apply -f /tmp/calico-custom-resources.yaml
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

# ── Generate join command for workers ─────────────────────────────────────

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
EOF
```

### `ansible/roles/k8s-worker/tasks/main.yml` — VM2 only

```bash
mkdir -p roles/k8s-worker/tasks
cat > roles/k8s-worker/tasks/main.yml <<'EOF'
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
EOF
```

Commit the corrected roles:
```bash
cd ~/devsecops-pipeline
git add ansible/
git commit -m "fix Ansible for Ubuntu 24.04+: K8s 1.34, Calico 3.32, keyrings, non-overlapping pod CIDR"
git push
```

## C6. Test connectivity before running anything 🐧 WSL2

```bash
cd ~/devsecops-pipeline/ansible
ansible -i inventory/hosts.ini k8s_cluster -m ping
```
Expected:
```
k8s-master   | SUCCESS => { "ping": "pong" }
k8s-worker1  | SUCCESS => { "ping": "pong" }
```

**✅ Checkpoint:** both return `pong`. If not, fix SSH/inventory before continuing.

## C7. Run the playbook 🐧 WSL2

```bash
ansible-playbook -i inventory/hosts.ini playbook.yml
```
Three plays, in order:
1. **common** on both VMs — swap off, kernel modules, containerd, kubeadm/kubelet/kubectl
2. **k8s-control-plane** on VM1 — `kubeadm init` + Calico + join token
3. **k8s-worker** on VM2 — `kubeadm join`

> Takes ~5–15 min. Look for `failed=0` per host in the final summary.

## C8. Verify the cluster 🖥️ VM1

```bash
ssh $VM1_USER@$VM1_IP
kubectl get nodes
```
Expected:
```
NAME          STATUS   ROLES           AGE   VERSION
k8s-master    Ready    control-plane   5m    v1.34.x
k8s-worker1   Ready    <none>          3m    v1.34.x
```

**✅ Phase 2 done.** Both nodes `Ready`.

---

# PART D — Wire Phase 1 → Phase 2 (the deploy stage)

This closes the loop: it's the piece the architecture diagram currently shows as missing.

1. **Push the image to GitLab Container Registry** so the cluster can pull it. Add to the
   `build-image` job:
   ```yaml
   - docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
   - docker tag "$IMAGE_NAME:$IMAGE_TAG" "$CI_REGISTRY_IMAGE:$IMAGE_TAG"
   - docker push "$CI_REGISTRY_IMAGE:$IMAGE_TAG"
   ```
   (`CI_REGISTRY*` variables are provided automatically by GitLab.)

2. **Update `k8s-manifests/deployment.yaml`** — replace the `REGISTRY/myapp:TAG` placeholder
   with `$CI_REGISTRY_IMAGE:$IMAGE_TAG`, substituted at deploy time.

3. **Add a `deploy` stage** running `kubectl apply -f k8s-manifests/` after all four gates pass.
   Two routes: install a GitLab runner on VM1, or store VM1's kubeconfig as a **masked** CI/CD
   variable. The runner-on-VM1 route avoids putting cluster credentials in GitLab at all.

4. **Add observability** — Prometheus + Grafana on the cluster.

5. **Finish the README** with the architecture diagram and scan-report screenshots.

---

# Troubleshooting Quick Reference

| Symptom | Fix |
|---|---|
| `UNPROTECTED PRIVATE KEY FILE` from ssh | You're working on `/mnt/d`. Move to `~/devsecops-pipeline` (B2). |
| `ansible ping` → "Permission denied (publickey)" | Re-run `ssh-copy-id` from WSL2; confirm `ansible_user` in `hosts.ini` matches `whoami` on the VM. |
| `ansible ping` → "Failed to connect ... port 22" | VM off, wrong IP, or SSH not running (`sudo systemctl enable --now ssh`). |
| Ansible asks for a sudo password mid-run | The `NOPASSWD` sudoers line (C1c) wasn't applied on that VM. |
| `kubeadm init` fails: "container runtime is not running" | containerd config wasn't regenerated — the C5 `common` role fixes this. Confirm you replaced the stale roles. |
| Playbook fails on `kubeadm init` | Swap still on, or fewer than 2 vCPU. Check `swapon --show` is empty. |
| Node stuck `NotReady` | CNI not applied. `kubectl get pods -n calico-system`, and confirm pod CIDR is `10.244.0.0/16` in *both* kubeadm and Calico. |
| Pods can't reach each other / weird routing | Pod CIDR overlaps your LAN. Must be `10.244.0.0/16`, not `192.168.0.0/16`. |
| `glab` push rejected | `glab auth status`; regenerate the token with `write_repository` scope. |
| WSL can't reach the VMs | If VirtualBox NAT, switch the adapter to **Bridged**. VMware: use the same subnet your host is on. |
| CI: "Cannot connect to the Docker daemon" | Confirm the job has `services: [docker:24.0-dind]` and the `DOCKER_TLS_CERTDIR` variables. Retry once — dind can be slow to boot. |
| ZAP report missing/empty | `chmod 777 reports` missing, or DVWA didn't finish booting — check the `docker logs target` output in the job log and raise the `sleep` values. |
| Every gate green on first run | Suspicious — DVWA should fail all of them. Check Semgrep has `--error` and Trivy has `--exit-code 1`. |
| VM's static IP reverts after reboot | The cloud-init disable file (C1a) wasn't created. |

---

# Your Progress Checklist

**Setup**
- [x] Git identity configured
- [ ] Part 0 — VM IPs/usernames saved to `~/.devsecops-env`
- [ ] WSL2 installed; git + glab installed and authenticated *inside WSL* (A1–A3)

**Phase 1**
- [x] DVWA installed in `app/` + `app/Dockerfile`
- [x] `.gitlab-ci.yml` written (5 stages, gates report-only)
- [x] `.gitignore` + `reports/.gitkeep`
- [ ] GitLab project created (B1)
- [ ] Repo copied to WSL home + git initialised + remote added (B2)
- [ ] First pipeline run — all 5 jobs complete (B4–B5)
- [ ] All four reports downloaded and read (B6)
- [ ] Gates tightened to `allow_failure: false` (B7)

**Phase 2**
- [ ] Static IPs + SSH + passwordless sudo on both VMs (C1)
- [ ] SSH keys copied, passwordless login works (C2)
- [ ] Ansible installed in WSL (C3)
- [ ] Inventory generated from your settings (C4)
- [ ] **Stale Ansible roles replaced with the corrected versions (C5)**
- [ ] `ansible ping` returns pong on both nodes (C6)
- [ ] `ansible-playbook` completes with `failed=0` (C7)
- [ ] `kubectl get nodes` shows both nodes Ready (C8)

**Finale**
- [ ] Image pushed to registry + deploy stage added (D)
- [ ] README with diagram + screenshots (D)
