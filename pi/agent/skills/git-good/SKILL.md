---
name: git-good
description: >
  Safety guardrails for git operations. Invoke before ANY session involving
  git commits, pushes, rebases, merges, conflict resolution, branch operations,
  or history rewriting, and before opening or updating a PR. Keeps review fixes
  visible, folds explicit fixups before PR publication, and protects work during
  history changes. Follows the user's conventions.
---

# git-good

**Git history belongs to the user. Preserve work and keep changes easy to review.**

When in doubt, create a new commit.

## Gate

Before running any git command, check this table and follow every matching row. If no row matches, proceed.

| If you're about to...                | Do this instead                                          |
|--------------------------------------|----------------------------------------------------------|
| Incremental corrections or amend | Follow [Review corrections](#review-corrections) |
| `git add .` or `git add -A`          | `git add <specific-files>`                               |
| Push or open a PR | Follow [Before PR publication](#before-pr-publication) |
| `git push --force` | Require remote-rewrite approval; follow [Force pushes](#force-pushes) |
| `git reset --hard`                   | Prefer `--soft`; a safety branch alone cannot protect uncommitted work |
| `git checkout --theirs` / `--ours`   | Edit conflict markers manually                           |
| `git checkout -- <file>`             | Prefer `git restore`; both discard uncommitted changes   |
| `git rebase --skip`                  | Verify the change is already retained or intentionally excluded; preserve the original tip |
| `git branch -D`                      | Verify another named ref retains the tip and no worktree uses the branch; otherwise ask |
| `git clean -f`                       | Back up affected untracked/ignored files or get explicit discard approval |
| `git stash drop` / `git stash clear` | Retain every affected stash object with backup refs or get explicit discard approval |
| `git rebase` or autosquash | Confirm the task calls for it, preserve the tip, and follow the relevant checklist |
| HEAD is detached (no branch)         | Create a branch before committing: `git switch -c <name>`|
| Rebase/merge already in progress     | Resolve or abort before doing anything else              |
| Running git with no TTY              | Neutralize editors: `-c core.editor=true -c sequence.editor=true` (see [Non-interactive execution](#non-interactive-execution-agent-shells)) |

**First git operation in a session?** Run `git config --get merge.conflictstyle`. If not `diff3` or `zdiff3`, warn the user:
set `git config --global merge.conflictstyle zdiff3` for three-way conflict markers.

## Commits

### Review corrections

Use `git commit --fixup=<sha>` for incremental corrections, including review feedback. Keep fixups separate
during development and review until the user requests cleanup or PR publication. Use `git commit --amend`
when the user requests amending.

Target fixups at the change they correct. Use `git log -S` or `git blame` when the target is unclear.

### Stage specific files

Never `git add .` or `git add -A`. Stage by path. Review with `git diff --staged` before committing.

### Verify your branch

Before committing, check `git branch --show-current`. If it returns empty, you're in detached HEAD - create a branch
with `git switch -c <name>`. If it returns `main` or another protected branch, use a feature branch unless the user
explicitly directed work there. Follow the local worktree workflow when creating branches.

### Follow conventions

Check `git log --oneline -10` and match the user's commit message style. Check `git branch --list` and match their
branch naming. Write clear commit messages. Existing WIP or checkpoint commits do not block saving progress
or an authorized private backup push.

### Before PR publication

Before pushing, check whether the destination branch has an open PR, including drafts. Pause if PR status
cannot be verified. When opening a PR or pushing to an existing one, inspect the outgoing commits and full PR
range against its actual base.

Preserve ordinary commits and their boundaries. Autosquash explicit `fixup!`, `squash!`, and `amend!` commits
into their targets. A request to push PR updates or open a PR includes this preparation without another permission
prompt. A private checkpoint or backup push can retain those markers.

When folding marked commits, create a safety branch and follow the [Autosquash checklist](#autosquash-checklist),
then recheck the history and verify tree identity. Ask if a fixup target or the PR base is unclear.
Stop before publishing if cleanup or verification fails. Confirm the remote branch matches the checked commits
before creating a PR.

## Conflicts

Applies during rebases, merges, and cherry-picks.

### Read all three sides

With diff3, conflict markers have three sections:

```
<<<<<<< ours
||||||| base (common ancestor)
=======
>>>>>>> theirs
```

Before editing, understand: what did ours change vs base? What did theirs change vs base? Can both coexist, or do they
conflict semantically?

### Edit surgically

- Modify only lines inside the conflict region
- Remove ALL conflict markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`)
- Never replace an entire file with one side
- Verify with `git diff -- <file>` and investigate any resolution that deletes one side's changes entirely

### When to stop

If you can't confidently combine both sides, describe the conflict to the user and ask. Never guess on semantic
conflicts.

## History changes and destructive operations

Confirm the task calls for the operation. For local history changes, create a uniquely named safety branch and
verify it retains the original full SHA. Recoverable local steps need no separate permission.

Inspect staged, unstaged, and untracked work before reset, restore, clean, or recovery. A safety branch protects
committed history. Preserve affected uncommitted work separately and verify the backup, or get explicit discard
approval. Apply the same protection to stash deletion, branch deletion, and history filtering.

Pushes, remote deletion, and PR creation, edits, or merges need authorization covering the operation and
destination. Use existing approval when it covers the action. Obtain approval for a remote-history rewrite
before force-pushing; follow [Force pushes](#force-pushes).

After a rebase, compare against the safety ref and run applicable checks. History-only cleanup must preserve
the exact tree. For a changed base, inspect the replayed changes and conflict resolutions, then build and test.
Retain safety refs until the user authorizes cleanup.

---

## Reference

Detailed procedures for complex operations. The rules above take precedence.

### Conflict prediction

Before a non-trivial rebase or merge, predict the conflict surface before touching the working
tree so you can plan resolution, choose merge vs. rebase, or warn the user up front.

Get the scope:

```
git log --oneline <target>..HEAD
```

Predict conflicts using Git's real merge engine, in memory:

```
git merge-tree --write-tree --name-only <target> HEAD
echo "exit=$?"
```

`--write-tree` runs without changing the working tree, index, or HEAD. Exit code 0 = clean,
1 = conflicts, 2+ = error. The merged tree OID is written first, followed by conflicted paths.
Drop `--name-only` to see modes and stages (distinguishes content, modify/delete, rename).

For rebases, treat the result as a lower bound. A rebase replays commits one at a time and can
surface conflicts in intermediate states that a single merge resolves silently.

If the predicted conflict set is non-trivial (modify/delete, renames, many files), document a
resolution strategy per file before starting.

### Rebase checklist

**Pre-flight:**

1. Verify branch: `git branch --show-current`
2. Verify clean: `git status --porcelain` (must be empty)
3. Safety branch: `git branch temp/pre-rebase-<branch>` (use a unique suffix if the name exists); verify its full SHA
4. Note SHA: `git rev-parse --short HEAD`
5. For non-trivial rebases, predict conflicts (see [Conflict prediction](#conflict-prediction))
6. Start with `git rebase --no-update-refs --no-autostash ...` to preserve safety refs and other branches

**Per-commit conflicts:** Follow the [Conflicts](#conflicts) section above. Additionally:

- If rerere is enabled: `git rerere diff` to inspect what rerere auto-applied
- If cached resolution looks wrong: `git rerere forget <file>`

**Post-rebase:**

1. `git diff --stat temp/pre-rebase-<branch>` - unexpected changes mean something went wrong
2. For reorder-only rebases (autosquash): verify tree identity.
   `git rev-parse "temp/pre-rebase-<branch>^{tree}"` must equal `git rev-parse "HEAD^{tree}"`.
   A mismatch means the rebase changed file content; investigate before proceeding.
3. Build and test
4. If broken: check for new uncommitted work and follow
   [History changes and destructive operations](#history-changes-and-destructive-operations) before resetting
5. Don't delete safety branch until user confirms

### Staged rebasing checklist

Staged rebasing splits a single large rebase into a sequence of smaller rebases, each landing on
an intermediate target commit on the way to the final target. Use when a rebase is too large to
keep coherent in one pass: many predicted conflicts, hundreds of commits behind the target, or a
previous single-shot attempt ran out of context. Each stage produces a verifiable checkpoint and
contains the blast radius of a bad resolution. Total conflict work does not decrease; the wins are
checkpointing and smaller per-stage context.

**Pre-flight:**

1. Identify candidate intermediate targets on the path to the final target: released tags,
   CI-green merges to the default branch, or marked release commits. Avoid arbitrary midpoints -
   checkpoints require a working build. Verify ancestry with
   `git merge-base --is-ancestor <candidate> <final-target>`.
2. Build an ordered list of candidate stages from current base to final target. Use
   [conflict prediction](#conflict-prediction) to keep only stages where rebasing onto the
   intermediate is materially easier than skipping past it. If no stage helps, skip staging.
3. Enable [rerere](#rerere-cache) if appropriate, and plan to inspect `git rerere diff` at each
   stage before continuing - staging can amplify a bad cached resolution across multiple stages.

**Per stage:** Follow the [Rebase checklist](#rebase-checklist), substituting
`temp/pre-rebase-<branch>-stage-N` for every reference to `temp/pre-rebase-<branch>`. After the
stage succeeds, advance to the next stage and repeat until done.

**Wrap-up:** Don't delete stage safety branches until the user confirms the full sequence is good.

### Autosquash checklist

Autosquash moves each marked commit beside its target. Check targets and dependencies before replaying.

#### 1. Audit fixup targets

For each fixup, inspect its patch, the target commit, and the intervening history:

```
git show <fixup-sha>
git show <target-sha>
git ls-tree -r --name-only <target-sha>
```

Verify the patch belongs with that change and can apply immediately after its target. Check the target's tree
and intervening dependencies. Files can predate the target or be introduced by the fixup.

#### 2. Resolve targeting problems

If a fixup cannot apply at its declared target, identify the dependency. Retarget or split it when the correct
targets are clear from the requested change. Ask when they are unclear. Preserve the original tip and all changes.

#### 3. Verify the todo list

Review the generated `git rebase -i --autosquash` todo before proceeding. With no TTY, dump it for review
instead of opening an editor (see [Non-interactive execution](#non-interactive-execution-agent-shells)).
Each fixup should follow its intended target, before later commits that depend on the corrected change.
If it depends on a later commit, abort and fix the targeting or split the fixup.

#### 4. Run the rebase and verify tree identity

After autosquash completes, the tree hash must match the pre-rebase state (same content, different history):

```
git rev-parse "temp/pre-rebase-<branch>^{tree}"
git rev-parse "HEAD^{tree}"
```

Investigate any mismatch before proceeding.

### Force pushes

Before an authorized remote-history rewrite, fetch and inspect the destination tip. Account for remote-only
commits and preserve the reviewed tip with a safety ref. Use
`git push --force-with-lease=<ref>:<reviewed-sha>`, binding the lease to the SHA reviewed for cleanup.

If the remote advances, stop and reconcile the new work. Get approval for changes beyond the authorized scope.
Keep the reviewed SHA as the lease expectation until that review is complete. Never use `--force`.

### rerere cache

rerere caches conflict resolutions for replay. A bad resolution gets silently re-applied.

- After every conflict resolution: `git rerere diff` (inspect the resolution rerere will record)
- Bad resolution for a specific file: `git rerere forget <path>` (requires active conflicts)
- Before clearing the entire cache, back it up or get explicit discard approval
- When retrying a failed rebase with suspected bad cache: start the rebase, let rerere auto-apply, then
  `git rerere forget <file>` on bad auto-resolutions and re-resolve manually

### Recovery

Check for new uncommitted work and follow
[History changes and destructive operations](#history-changes-and-destructive-operations) before resetting.

- **Safety branch:** inspect the saved tip, then reset to it; prefer `--soft` when it meets the recovery goal.
- **reflog:** `git reflog` can help find an earlier tip if a safety ref is missing. Create a named ref before recovery.
- **Bad amend:** `git reset --soft <saved-tip>` restores the original commit while keeping amend changes staged.
- Always explain to the user: what went wrong, what you're restoring to, what they should verify.

### Non-interactive execution (agent shells)

Git opens the user's editor whenever it needs a message or plan it can't infer: `git rebase --continue` after a
conflict (to confirm the message), `git rebase -i` (the todo list), `squash` and `reword` steps, `git merge --edit`,
and `git commit` with no `-m`. In a terminal that's fine. In a shell with no TTY - where an agent runs - the editor has
nothing to attach to, so the command hangs with no error and no output - an unbounded stall.

Two editors trigger this: the message editor (`core.editor`) and the sequence editor (`sequence.editor`, the
`rebase -i` todo). Point both at `true` for the command - a no-op editor that exits 0 without writing, so git keeps
what it pre-filled: the original message on a plain-pick `--continue`, the flag-ordered todo on `--autosquash`.

```
git -c core.editor=true -c sequence.editor=true rebase --continue
git -c core.editor=true -c sequence.editor=true rebase -i --autosquash --no-update-refs --no-autostash <base>
```

A `GIT_EDITOR` or `GIT_SEQUENCE_EDITOR` exported in the environment overrides these, and that's intended: git-good
supplies a default for the TTY-less case, it doesn't override an editor the harness set on purpose.

To author a message rather than keep git's, pass it explicitly: `git commit -m` for a standalone commit,
`git commit --amend -m` for a requested amend after preserving the original tip, or a scripted editor writing to
the file git hands it (`$1`) for a `reword`. To inspect a proposed message or todo, point the editor at a script
that prints the file git hands it (`$1`) and exits non-zero, which aborts cleanly for review; rerun with `true`
once it checks out. Hooks still run and can hang too, but a silent stall is usually the editor.

### Prerequisites

**merge.conflictstyle = diff3 or zdiff3** (checked on first git op):

Without diff3/zdiff3, conflict markers only show two sides. The base version is critical for understanding what each side
changed. Set with `git config --global merge.conflictstyle zdiff3`.

**git >= 2.38** (required for [Conflict prediction](#conflict-prediction)):

`git merge-tree --write-tree` was added in Git 2.38 (October 2022). Earlier versions can't predict
conflicts without touching the working tree. Check with `git --version`.

**rerere.enabled = true** (optional):

Caches conflict resolutions for replay. Useful for stacked-diff workflows. Set with
`git config --global rerere.enabled true`. See [rerere cache](#rerere-cache) section above.


