# Git workflow for AI agents and contributors (read before touching git)

Goal: **never hit "Merge blocked: Merge conflicts must be resolved" again.**

## Rules of the project

1. Work and commit on `dev`. Push `dev` only.
2. The user reviews the merge request and merges `dev` -> `main` in GitLab.
   **Never merge, push, rebase or force-push `main` yourself.** Merging `main`
   is the deploy trigger (Komodo webhook), see `docs/CLOUDFLARE_TUNNEL.md`.
3. Update the docs in the same commit as the code (`docs/PROJECT_STRUCTURE.md`
   is canonical).
4. Never commit secrets (`credentials.md`, tokens, `webui/data/`).

## Why the conflict keeps happening (root cause)

The GitLab MR has **Squash commits** ticked. On merge, GitLab replaces all of
`dev`'s commits with ONE new commit on `main`. `dev` still holds the original
commits, so the two branches now have the same *content* but different *history*.
GitLab shows "N commits behind", and anything committed on `dev` after that
point (or edited in the same lines) conflicts.

Cycle that produces it: merge (squash) -> keep committing on old `dev` ->
open next MR -> conflict.

## The fix: sync `dev` with `main` at these moments

Do this **every time**, not only when a conflict shows up:

1. **At the start of any task / new session**
2. **Right after the user says they merged**
3. **Immediately before every `git push origin dev`**

```bash
git fetch origin
git status -sb                      # on dev? clean tree?
git log --oneline dev..origin/main  # anything here means dev is behind
git merge --no-commit origin/main   # bring main's squash commits into dev
```

- No conflicts: `git commit` (or `git merge --continue`), then continue.
- Conflicts: resolve them (below), then commit.
- Nothing printed by the `log` line: already in sync, skip the merge.

Because the merge commit records `origin/main` as a parent, GitLab sees `dev`
as up to date and the next MR is conflict-free. Skipping this step is the
mistake.

## Resolving conflicts correctly

```bash
git diff --name-only --diff-filter=U        # which files
grep -n '^<<<<<<<\|^=======\|^>>>>>>>' <file>
```

- `HEAD` (top half) is `dev`, `origin/main` (bottom half) is `main`.
- After a squash, `main` is usually the *older* copy of the same work, so
  **keep dev's side** unless `main` clearly has a newer unrelated change.
- Remove every marker line. Then verify:
  ```bash
  grep -c '^<<<<<<<\|^>>>>>>>' <file>         # must print 0
  node --check <each changed .js file>        # everything parses
  git diff --cached origin/main --stat        # only intended work differs
  ```
- On Windows files are CRLF: edit with the Edit tool or `sed -i` on line
  numbers, not multi-line string replacement.
- Then `git add -A && git commit && git push origin dev`.

Confirm GitLab agrees:
`GET /projects/:id/merge_requests/:iid` -> `has_conflicts:false`,
`detailed_merge_status:"mergeable"` (token handling: `docs/CLOUDFLARE_TUNNEL.md` step 4).

## Best long-term prevention (tell the user)

- **Untick "Squash commits"** in the MR, or set the project to
  *Merge commit* / fast-forward. Then history is shared and `dev` is never
  "behind" after a merge.
- Or after each merge run `git fetch && git merge origin/main` on `dev` before
  any new work (the routine above).

## Do NOT

- `git push --force`, `git reset --hard origin/main`, or rebase `dev` onto `main`
  without the user's say-so: it can destroy commits the user made themselves
  (the user edits files and pushes to `dev` too).
- Resolve by taking `main` wholesale (`-X theirs` / `checkout --theirs`): it drops dev's work.
- Touch `main`.
- Assume `dev` is unchanged: the user also commits to it. Always `git fetch` and
  read `git log dev..origin/dev` if in doubt.
