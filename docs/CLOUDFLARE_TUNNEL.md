# Cloudflare quick tunnel + GitLab webhook: runbook (human or AI)

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
   -> Cloudflare -> cloudflared (systemd, on kan2server) -> localhost:9120
   -> Komodo listener -> redeploys Stack "gametorrent-webui"
```

Only Komodo's listener (port 9120) is exposed. The listener path is fixed:
`/listener/gitlab/stack/gametorrent-webui/deploy`. The **secret token**
(header `X-Gitlab-Token`) is what protects it.

Symptom that means "run this runbook": a merge to `main` did not redeploy, or
the user says the tunnel is down / gives a new `trycloudflare.com` URL.

## 1. Facts you need (all in the repo or credentials.md)

| Thing | Value / where |
|---|---|
| VM | `<ssh-user>@<vm-ip>`, SSH key auth (details in the private `credentials.md`) |
| Tunnel service | systemd unit `cloudflared-komodo-tunnel` |
| Komodo listener | `http://localhost:9120` on the VM |
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

Create `/etc/systemd/system/cloudflared-komodo-tunnel.service`:

```ini
[Unit]
Description=Cloudflare quick tunnel to Komodo listener
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/cloudflared tunnel --no-autoupdate --url http://localhost:9120
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-komodo-tunnel
```

## 3. Get the current tunnel URL (or a fresh one)

```bash
ssh <ssh-user>@<vm-ip> "sudo systemctl is-active cloudflared-komodo-tunnel; \
  sudo journalctl -u cloudflared-komodo-tunnel --no-pager | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1"
```

Decide by what you see:

- URL printed and no recent errors: candidate URL. Go to 5 (verify).
- Journal shows `Unauthorized: Tunnel not found` (service still `active`): Cloudflare
  deleted the quick tunnel. Restart it, then re-read the URL:
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
   suffix (`glpat-....01.xxxx`). Extracting it with a `glpat-[A-Za-z0-9_-]*`
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
| 404 | wrong path/stack name | path must be exactly `/listener/gitlab/stack/gametorrent-webui/deploy` |

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
  `http://localhost:9120`, and run `cloudflared tunnel run gametorrent`. The URL
  never changes, so step 4 is done once.
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
| Current URL | journalctl grep in step 3 |
| Update webhook | step 4 |
| Verify | step 5 |
