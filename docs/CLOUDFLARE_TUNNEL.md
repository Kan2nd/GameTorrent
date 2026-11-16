# Cloudflare quick tunnel + GitLab webhook: runbook (human or AI)

**Retired 2026-10-10 — this whole setup is gone.** `gametorrent-webui` now
deploys via Argo CD on k3s (pull-based polling, no public endpoint needed —
see `docs/K8S_MIGRATION.md`), so the tunnel/proxy/webhook this runbook
describes no longer exist: the GitLab webhook was deleted, the
`cloudflared-komodo-tunnel`/`cloudflared-watchdog` services were
stopped+disabled and their files removed (`docker/host/README.md`), and
`docker/webhook-proxy/` is gone. Kept below as reference only, in case this
pattern (tunnel -> narrow proxy -> internal service, see `log/C2`) is useful
again for something else later.

Follow this top to bottom and you can set up, check, and repair the deploy
tunnel without any prior context. It assumes **no domain**, so it uses a free
Cloudflare *quick tunnel*, whose URL is random and changes on restart. That is
the reason this runbook exists.

No secrets are in this file. Real values live in the gitignored
`credentials.md` and in `D:\STUDY\Sem alone\gitlantoken.md` (outside the repo).
Never print, log or commit them.

## 0. The 30-second picture

```
merge to main -> GitLab webhook -> https://<random>.trycloudflare.com
   -> Cloudflare -> cloudflared (systemd, on kan2server) -> 127.0.0.1:9180
   -> webhook-only proxy (Caddy) -> Komodo listener :9120 -> redeploys Stack "gametorrent-webui"
```

**The tunnel must point at the proxy on `:9180`, never straight at Komodo's
`:9120`.** A quick tunnel forwards a whole port, so pointing it at `:9120`
publishes Komodo's entire UI and API (Komodo controls Docker = root on the VM).
The proxy (`docker/webhook-proxy/`) lets through exactly one request —
`POST /listener/gitlab/stack/gametorrent-webui/deploy` — and answers 404 to
everything else. That path's **secret token** (header `X-Gitlab-Token`) is then
checked by Komodo itself. Komodo's UI stays reachable on the LAN/Tailscale at `:9120`.

Symptom that means "run this runbook": a merge to `main` did not redeploy, or
the user says the tunnel is down / gives a new `trycloudflare.com` URL.

## 1. Facts you need (all in the repo or credentials.md)

| Thing | Value / where |
|---|---|
| VM | `<ssh-user>@<vm-ip>`, SSH key auth, passwordless sudo (`credentials.md`) |
| Tunnel service | systemd unit `cloudflared-komodo-tunnel` → `http://localhost:9180` |
| Webhook proxy | container `komodo-webhook-proxy` on `127.0.0.1:9180` (`docker/webhook-proxy/`) |
| Komodo listener | `core:9120` (reached by the proxy over Docker's `komodo_default` network) |
| Tunnel watchdog | timer `cloudflared-watchdog` (every 5 min) — restarts a dead tunnel |
| Current URL file | `/etc/komodo/tunnel-url` (kept up to date by the watchdog) |
| GitLab project | `kannguyen3105/gametorrent` (URL-encoded: `kannguyen3105%2Fgametorrent`) |
| Webhook id | `<webhook-id>` |
| Webhook secret | `credentials.md`, line "Webhook secret" |
| GitLab API token | file `D:\STUDY\Sem alone\gitlantoken.md` (see gotcha in 4) |
| Branch filter | `main` |

## 2. First-time install (only if `cloudflared` is missing)

Run on the VM (`ssh <ssh-user>@<vm-ip>`, from WSL on the user's PC):

```bash
curl -sSL -o /tmp/cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i /tmp/cloudflared.deb
```

Start the webhook-only proxy **first** (from a checkout of the repo on the VM):

```bash
sudo mkdir -p /etc/komodo/webhook-proxy
sudo cp docker/webhook-proxy/Caddyfile docker/webhook-proxy/compose.yaml /etc/komodo/webhook-proxy/
cd /etc/komodo/webhook-proxy && sudo docker compose -p komodo-webhook-proxy up -d
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9180/    # must print 404
```

Then install the tunnel unit (it points at `:9180`) plus the watchdog — all kept in
`docker/host/` (see its README):

```bash
sudo cp -r docker/host/usr docker/host/etc /
sudo chmod 750 /usr/local/bin/cloudflared-watchdog.sh /usr/local/bin/gametorrent-backup.sh
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-komodo-tunnel cloudflared-watchdog.timer gametorrent-backup.timer
```

## 3. Get the current tunnel URL (or a fresh one)

```bash
ssh <ssh-user>@<vm-ip> "cat /etc/komodo/tunnel-url; sudo journalctl -t cloudflared-watchdog -n 3 --no-pager"
```

The watchdog checks every 5 minutes: if Cloudflare dropped the tunnel ("Tunnel not
found") it restarts it, and it always writes the current URL to that file. If its log
says *"tunnel URL is now … repoint the GitLab webhook"*, the URL changed: do step 4.

Decide by what you see:

- URL printed and no recent errors: candidate URL. Go to 5 (verify).
- You don't want to wait for the watchdog: restart by hand, then re-read the URL:
  ```bash
  ssh <ssh-user>@<vm-ip> "sudo systemctl restart cloudflared-komodo-tunnel; sleep 8; \
    sudo journalctl -u cloudflared-komodo-tunnel --no-pager -n 30 | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1"
  ```
- The user pasted a URL in chat: use that one, still verify it in 5.

After every VM reboot the URL is new, so redo this whole runbook.

## 4. Point the GitLab webhook at the URL

Run from Git Bash on the user's PC, in the project folder. Replace `<HOST>`
with the tunnel host (no path).

```bash
cd "D:/STUDY/Sem alone/Project GameTorrent"
PAT=$(tr -d ' \r\n' < ../gitlantoken.md)
SEC=$(grep -i "Webhook secret" credentials.md | sed -E 's/.*[Ss]ecret:? *//; s/[`* ]//g')
URL="https://<HOST>/listener/gitlab/stack/gametorrent-webui/deploy"
API="https://gitlab.com/api/v4/projects/kannguyen3105%2Fgametorrent/hooks/<webhook-id>"

curl -s -X PUT -H "PRIVATE-TOKEN: $PAT" "$API" \
  --data-urlencode "url=$URL" --data-urlencode "token=$SEC" \
  --data-urlencode "push_events=true" --data-urlencode "push_events_branch_filter=main" \
  --data-urlencode "enable_ssl_verification=true" \
  | grep -o '"url":"[^"]*"\|"push_events_branch_filter":"[^"]*"\|"message":"[^"]*"'
```

Three traps that have already bitten this project:

1. **Always resend `token` in the PUT.** A PUT with only `url` wipes the secret
   and Komodo then answers 401, so deploys silently stop.
2. **Read the whole token file.** `gitlantoken.md` holds a token with a dotted
   suffix (`glpat-<redacted>`). Extracting it with a `glpat-[A-Za-z0-9_-]*`
   regex cuts it at the dot and gives `401 Unauthorized`. Use `tr -d ' \r\n'`
   on the entire file as above.
3. **Do not print the token or secret** (echo, `set -x`, error dumps). Print
   only lengths if you must debug (`${#SEC}`).

Expected output: the new `"url"` and `"push_events_branch_filter":"main"`.

## 5. Verify end to end

```bash
# 200 = tunnel up, secret accepted (a dev-branch payload is ignored, so nothing deploys)
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$URL" \
  -H "Content-Type: application/json" -H "X-Gitlab-Token: $SEC" \
  -d '{"object_kind":"push","ref":"refs/heads/dev"}'
```

| Result | Meaning | Action |
|---|---|---|
| 200 | tunnel + secret OK | done |
| 401 | secret mismatch | recheck `SEC` in `credentials.md` / Komodo webhook secret, redo 4 |
| 502/504, timeout, "internal error" | tunnel dead or wrong host | redo 3 |
| 404 | wrong path/stack name, or not a POST | the proxy only forwards `POST /listener/gitlab/stack/gametorrent-webui/deploy` |

Also confirm Komodo is **not** public — that's what the proxy is for:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://<HOST>/"   # must be 404, never the Komodo page
```

GitLab's own "Test -> Push events" button returns 422 for this project; use the
curl above instead. Real proof is the next merge to `main` (GitLab -> Settings ->
Webhooks -> Recent events should show 200).

To force a deploy now without a merge, send a `main` payload with the real secret:

```bash
curl -X POST "$URL" -H "Content-Type: application/json" -H "X-Gitlab-Token: $SEC" \
  -d '{"object_kind":"push","ref":"refs/heads/main"}'
```

Missed a deploy? In GitLab open the failed delivery under Recent events and
press **Resend**, or use the command above.

## 6. Update the docs (repo rule)

If the user-facing URL or procedure changed, update `credentials.md` (current
tunnel URL line; gitignored, do not commit) and commit doc edits to `dev`. The
project rule is: **commit and push `dev` only; the user reviews and merges to
`main`**. Never merge or push `main` yourself, because that is the deploy trigger.

## 7. Optional and background

- **Expose the UI too:** `cloudflared tunnel --url http://localhost:3000`
  (another quick tunnel). Prefer Tailscale for private access (see `docs/WEBUI.md`).
- **Stable URL:** needs a domain on Cloudflare DNS. Then use a named tunnel:
  `cloudflared tunnel login`, `cloudflared tunnel create gametorrent`,
  `cloudflared tunnel route dns gametorrent deploy.<domain>`, an ingress rule to
  `http://localhost:9180` (the proxy — still never `:9120` directly), and run
  `cloudflared tunnel run gametorrent`. The URL never changes, so step 4 is done once.
- **Quick tunnel guarantees:** none. It can vanish at any time.

## 8. Merge blocked by conflicts? (happened three times)

Cause: the MR squashes `dev`, so `dev` falls "N commits behind" `main`. Follow
`docs/GIT_WORKFLOW.md`: run `git fetch && git merge --no-commit origin/main` on
`dev` at the start of every task, after the user merges, and before every push.

## 9. Quick reference

| Task | Command |
|---|---|
| Is the tunnel service up? | `ssh <ssh-user>@<vm-ip> "systemctl is-active cloudflared-komodo-tunnel"` |
| Restart tunnel | `ssh <ssh-user>@<vm-ip> "sudo systemctl restart cloudflared-komodo-tunnel"` |
| Current URL | `ssh <ssh-user>@<vm-ip> "cat /etc/komodo/tunnel-url"` |
| Watchdog history | `ssh <ssh-user>@<vm-ip> "sudo journalctl -t cloudflared-watchdog -n 10"` |
| Proxy healthy? | `ssh <ssh-user>@<vm-ip> "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9180/"` → `404` |
| Update webhook | step 4 |
| Verify | step 5 |
