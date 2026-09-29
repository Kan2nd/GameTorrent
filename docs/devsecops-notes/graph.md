# DevSecOps Pipeline — Structure Map

Visual overview of the project as it currently stands. Two views:
1. **Repo layout** — what files live where
2. **Execution flow** — what runs, in what order, and on which machine

---

## 1. Repository Layout

```
~/devsecops-pipeline/            ← lives in your WSL2 home
│
├── .gitlab-ci.yml               ← pipeline entry point (4 security gates)
├── .gitignore                   ← ignores reports/, image.tar
├── README.md
│
├── app/                         ← the app under test (DVWA — deliberately vulnerable)
│   ├── Dockerfile               ← FROM vulnerables/web-dvwa (self-contained, port 80)
│   └── (DVWA PHP source)        ← what Semgrep SAST scans
│
├── ansible/                     ← Phase 2: builds the K8s cluster
│   ├── inventory/
│   │   └── hosts.ini            ← VM IPs + SSH user
│   ├── playbook.yml             ← master playbook (3 plays, in order)
│   └── roles/
│       ├── common/              ← runs on BOTH VMs
│       │   └── tasks/main.yml   ← swap off, containerd, kubeadm tools
│       ├── k8s-control-plane/   ← VM1 only
│       │   └── tasks/main.yml   ← kubeadm init, Calico, join token
│       └── k8s-worker/          ← VM2 only
│           └── tasks/main.yml   ← kubeadm join
│
├── k8s-manifests/
│   └── deployment.yaml          ← Deployment + Service (wired up in Phase 2)
│
└── reports/                     ← scan outputs (gitignored, kept as CI artifacts)
```

---

## 2. Where Everything Runs

```
┌──────────────────────────────────────────────────────────────┐
│  Your Windows 11 Host (16 GB RAM)                              │
│                                                                │
│   ┌────────────────────────────┐                              │
│   │  WSL2 (Ubuntu)             │   ← YOU WORK HERE             │
│   │   • git + glab             │      (git, glab, ansible)     │
│   │   • ansible                │                               │
│   │   • ~/devsecops-pipeline   │                               │
│   └───────────┬────────────────┘                              │
│               │ push (Phase 1)      │ SSH + Ansible (Phase 2)  │
│               │                     ▼                          │
│               │        ┌────────────────────────────────┐     │
│               │        │  VM1 — Control Plane (4GB/2cpu) │     │
│               │        │   kubeadm init + Calico CNI     │     │
│               │        └────────────────────────────────┘     │
│               │        ┌────────────────────────────────┐     │
│               │        │  VM2 — Worker Node   (4GB/2cpu) │     │
│               │        │   kubeadm join                  │     │
│               │        └────────────────────────────────┘     │
│               ▼                                                │
└───────────────┼────────────────────────────────────────────── ┘
                │
                ▼
        ┌──────────────────┐
        │  gitlab.com       │   ← Phase 1 CI runs in the cloud
        │  (free runners)   │      (4 security gates)
        └──────────────────┘
```

---

## 3. Phase 1 — CI Security Gate Flow

Runs automatically on every `git push`, on GitLab's cloud runners.

```
  git push
     │
     ▼
┌─────────────────────┐
│ 1. SAST             │  Semgrep scans source code
│    (semgrep)        │  → fails on HIGH/CRITICAL patterns
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 2. Dependency Scan  │  Trivy fs scans manifests
│    (trivy fs)       │  → fails on HIGH/CRITICAL CVEs
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 3. Build + Image    │  docker build → save image.tar
│    Scan             │  Trivy image scans layers
│    (docker + trivy) │  → fails on HIGH/CRITICAL CVEs
└─────────┬───────────┘
          ▼
┌─────────────────────┐
│ 4. DAST             │  ZAP baseline attacks running container
│    (owasp zap)      │  → warn-only at first, enforce later
└─────────┬───────────┘
          ▼
   Reports → CI artifacts (SARIF / JSON / HTML)
```

**Gate summary**

| # | Stage | Tool | Catches | Fails on |
|---|---|---|---|---|
| 1 | SAST | Semgrep | Insecure code patterns (OWASP Top 10) | HIGH / CRITICAL |
| 2 | Dependency scan | Trivy fs | Vulnerable libraries | HIGH / CRITICAL CVEs |
| 3 | Image scan | Trivy image | Vulnerable OS packages in layers | HIGH / CRITICAL CVEs |
| 4 | DAST | OWASP ZAP | Runtime web vulns (XSS, headers) | Warn-only at first |

---

## 4. Phase 2 — Ansible Provisioning Flow

Run once with `ansible-playbook` from WSL2 to build the cluster.

```
  ansible-playbook playbook.yml
     │
     ▼
┌──────────────────────────────┐
│ Play 1: common               │  → on BOTH VMs
│   swap off, kernel modules,  │
│   containerd, kubeadm tools  │
└─────────────┬────────────────┘
              ▼
┌──────────────────────────────┐
│ Play 2: k8s-control-plane    │  → VM1 only
│   kubeadm init               │
│   install Calico CNI         │
│   generate join token ───────┼──┐
└─────────────┬────────────────┘  │ token fetched
              ▼                    │ back to WSL
┌──────────────────────────────┐  │
│ Play 3: k8s-worker           │◄─┘
│   kubeadm join (using token) │  → VM2 only
└─────────────┬────────────────┘
              ▼
   kubectl get nodes → both Ready ✅
```

---

## 5. Current Status

```
[✅ scaffolded]   Repo structure, .gitlab-ci.yml, Ansible roles written
[✅ decided]      App = DVWA (vulnerable PHP) → APP_PORT 80, guarantees findings
[⬜ todo]         Clone DVWA into app/  +  add Dockerfile
[⬜ todo]         First pipeline run (all gates allow_failure: true)
[⬜ todo]         Tighten gates → allow_failure: false
[⬜ todo]         Bring up VMs → run playbook → verify cluster
[⬜ future]       Wire Phase 1 → Phase 2 (registry push + deploy stage)
```

> Phase 1 and Phase 2 are **not yet connected** — the deploy stage
> (`kubectl apply -f k8s-manifests/`) is the final step in "Next Steps".
