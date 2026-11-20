---
name: prune
description: >
  Review and delete merged, superseded, or abandoned git branches after explicit per-ref
  approval. Use when the user wants to clean up branches, find stale branches,
  or tidy a repo. Do not run `git prune` or `git remote prune`, which discard
  unreachable objects and stale remote-tracking refs rather than deleting branches.
---

# Prune: Interactive Branch Cleanup

Inventory branch refs, assess what work remains, and delete only what the user approves.
For rebases, force pushes, and history rewriting, see `git-good`.

## Ref invariants

A local branch and its remote counterpart are separate refs that can point at different
commits. Prove, present, approve, and delete each one independently, and carry the
fully-qualified refname in every row. Evidence about `refs/heads/<name>` never authorizes
deleting `refs/remotes/<remote>/<name>`.

Resolve every SHA from the full refname. `git rev-parse feature` reads the local branch
even when the row describes `origin/feature`, so a short name can prove one ref and delete
another.

`\$name` throughout means everything after `refs/heads/` or `refs/remotes/<remote>/`,
slashes included. For `refs/remotes/origin/users/matt/topic` it is `users/matt/topic`.
Taking the last segment instead yields `topic`, which names a different branch and deletes
the wrong ref.

Pass ref names as arguments, never by pasting them into a command string. Git accepts
branch names containing shell metacharacters, so `git update-ref -d refs/heads/$name` is
safe where the same name spliced into command text is not.

## 1. Resolve remotes, target, and scope

Use the user's requested review mode, or offer these modes with the initial scope questions:

- **Merged-only (default):** offer refs with the exact merge proof in phase 3.
- **Semantic:** also investigate superseded implementations, redundant stacks, and abandoned
  prototypes. Apply the user's discard policy; clarify only what it leaves ambiguous.

Apply the protection, file-preservation, recovery, and per-ref approval rules in both modes.

Read `git remote -v`. Identify the remote holding canonical history and, when it differs,
the one the user may delete from. In a fork workflow `upstream` is canonical and read-only
while `origin` is the user's fork.

Ask whether remote cleanup is authorized and for which remote. On a shared remote, ask
whether ownership is defined by branch namespace, such as `users/<name>/`, or by tip author
email, which is approximate because anyone can author the tip of anyone's branch. State the
rule when presenting and offer only matching refs. Treat every ref on a personal fork as
theirs.

Stop if the repo is a mirror. Detect it with `git config --get remote.<remote>.mirror` or a
fetch refspec of `+refs/*:refs/*`. A mirror clone's `git fetch --prune`, which this skill
runs, deletes `refs/prune/graveyard` and its reflog, so recovery vanishes the moment
deletion finishes.

Confirm `git reflog write` exists before asking for approval, since recovery depends on it:

    git reflog write

Resolve the target with `git symbolic-ref refs/remotes/<canonical>/HEAD`. It returns a full
ref such as `refs/remotes/origin/main`. Keep the full ref for commands. Ask the user when
the lookup fails.

Protect the target's local counterpart too. A target of `refs/remotes/origin/main` leaves
`refs/heads/main` unprotected, and it satisfies the merged rule whenever another branch is
checked out.

Ask which branches and patterns are protected beyond those, including long-lived branches
such as `release/1.x` whose latest synchronization pull request would otherwise satisfy the
merged rule.

Fetch only the confirmed remotes, and stop if a fetch fails, since stale refs produce
categorizations that look like evidence.

    git fetch <remote> --prune

## 2. Inventory refs

Run `git worktree prune --dry-run --verbose`, then ask before running `git worktree prune`
on its results. A worktree whose
directory is gone still holds its branch, so pruning frees it for deletion, but a worktree on
a disconnected network or removable drive looks identical and its branch should stay
protected.

    git for-each-ref --format='%(refname)%09%(objectname)%09%(committerdate:short)%09%(authoremail)%09%(subject)' refs/heads refs/remotes

One row per ref:

| Field | Source |
|---|---|
| `ref` | fully-qualified `refs/heads/...` or `refs/remotes/...` |
| `scope` | `local` or the remote name |
| `sha` | `%(objectname)`, full 40 characters |
| `subject`, `date` | `%(subject)`, `%(committerdate:short)` |
| `author` | `%(authoremail)`, used only when ownership is defined by author email |
| `checked_out` | a `branch <ref>` record in `git worktree list --porcelain` |
| `protected` | the target ref, its local counterpart, or a ref the user named in phase 1 |

Pair each `worktree <path>` record with the `branch <ref>` record that follows it. A ref
with such a pairing is worktree-backed, and its row carries the directory as well as the ref.
Name the directory even when it looks redundant. Directories get reused, so a branch is often
checked out in one named after a different branch.

A worktree directory can also hold uncommitted changes, untracked files, and ignored files.
List them in the row before asking approval, grouping build output by directory.

    git -C $dir status --porcelain --untracked-files=all --ignored

Pass `--untracked-files=all` and plain `--ignored`. The first defeats a repo-local
`status.showUntrackedFiles=no` and expands ignored directories into their files. Narrowing to
`--ignored=matching` collapses them again, so an ignore rule on a directory reports one line
and hides everything under it.

Under `--untracked-files=all` an ordinary untracked directory expands into its files, so any
entry still ending in a slash is a nested repository. Check it before offering the row: a clone
inside a worktree can hold history that exists nowhere else.

Keep, and never offer, a worktree-backed ref whose directory is the main worktree, which
`git worktree list --porcelain` emits first, contains another registered worktree path, is
missing or `prunable`, is `locked`, or holds an initialized submodule.
Removing an outer directory deletes a nested worktree and its uncommitted files even when
ignore rules hide it, and removing a missing path silently unregisters a worktree that is
merely offline.

Split each row on the first four tabs only, since a subject can contain one. Skip
`refs/remotes/<remote>/HEAD`, a symbolic ref rather than a branch. Bare and detached
worktrees emit no `branch` record and protect nothing, so match those records rather than
searching the output for a name, which also matches paths and lock reasons.

## 3. Categorize

Apply the first rule that matches.

Keep any protected ref.

A worktree-backed ref stays eligible only together with its directory. Categorize it by the
rules below, and when offering deletion, offer both in one row.

Keep any ref with an open pull request, found with `gh pr list --head <name> --state open`
or `az repos pr list --source-branch <ref> --status active`. Test this before merge status,
because a branch whose old pull request merged can carry new work under a new one, and
testing merge first classifies it as merged and deletes that work.

Treat a ref as merged when its tip is already an ancestor of the target, which covers merge
commits and fast-forwards and needs no API:

    git merge-base --is-ancestor <ref> <target-ref>

Otherwise a squash or rebase merge counts only when all three hold: the pull request is
merged or completed, its head commit equals the ref's current SHA, and its merge commit is
an ancestor of the target.

| Value | GitHub (`gh pr view --json`) | Azure DevOps (`az repos pr show`) |
|---|---|---|
| head commit | `headRefOid` | `lastMergeSourceCommit.commitId` |
| merge commit | `mergeCommit.oid` | `lastMergeCommit.commitId` |

Read both from the pull request API rather than from commit messages, which do not reliably
carry either.

Label equal tip SHAs as shared tips. Establish any rename separately. In merged-only mode,
keep refs that lack the merge proof above and label them unknown.

### Semantic review

For each remaining ref, identify work absent from the current target. Include the whole
branch diff, later commits, and uncommitted work in its worktree. Use `git cherry` or patch
IDs to locate related changes, then verify their effect through current code, tests, PR
discussions, and replacement PRs.

Recommend deletion as **superseded** when the intended work landed in another form or is
fully contained in a retained stack. Cite the landed implementation or retained ref and
record any remaining behavioral differences. For unmerged stacks, name the copy to retain.
Classify prototypes and alternate implementations as **abandoned** under the user's
confirmed discard policy. Reserve **merged** for refs with the exact proof above.

Keep refs with genuinely unique remaining work and explain what the target lacks. Label
unresolved cases **unknown** and name the missing check. Complete the semantic assessment
before presenting deletion recommendations.

## 4. Present

One row per ref, grouped by category, deletable rows first:

| Ref | Scope | Proof | Tip | Last commit |
|---|---|---|---|---|
| `refs/heads/feature/login` | local | PR #142 merged, head matches | `a1b2c3...` | 2026-07-14 Add login |
| `refs/remotes/origin/feature/login` | origin | tip is ancestor of target | `a1b2c3...` | 2026-07-14 Add login |
| `refs/heads/feature/api` | local + worktree `D:\wt\api` | PR #150 merged, head matches | `d4e5f6...` | 2026-07-20 Add API |



In semantic mode, distinguish merged, superseded, and abandoned candidates and include each
candidate's evidence and remaining differences. Follow with the unknown rows, then a
one-line-per-ref summary of what stays and the unique work or protection that keeps it.

## 5. Approve and delete

Number the deletable refs and ask for the numbers to delete. Accept a comma-separated
list, or `all` once the user has seen the numbered list. Reprint and ask again if the
inventory changed after they read it, and give the retention warning from Recovery before
asking. For a worktree-backed row, say separately that approval destroys the directory: the
graveyard recovers the branch tip and nothing on disk, so uncommitted files, ignored files
such as local `.env`, and any untracked work are gone for good.

Approval covers one ref at one SHA. Delete only the operation its scope names: approving
`refs/remotes/origin/topic` authorizes the remote deletion alone and never touches local
`topic`, which may hold different commits.

Initialize the graveyard once before the loop:

    git update-ref --create-reflog -m "prune: init" refs/prune/graveyard <target-sha>

For each approved ref, append a recovery entry without moving the ref, and abort that ref if
the append fails. `git reflog write` does not require `old-oid` to match anything, so the
graveyard is a journal of deleted tips rather than a history of real transitions:

    git reflog write refs/prune/graveyard <target-sha> $approvedSha "prune: $ref"

For a worktree-backed row, confirm the ref still resolves to its approved SHA before touching
the filesystem. Directory removal is irreversible and the ref check is not, so run the cheap
check first:

    git rev-parse refs/heads/$name    # must equal $approvedSha, else skip the row

Before removal, ask which of the row's listed files to preserve and where to put them. Copy
those outside every worktree being deleted and verify the copies. Immediately before removing,
re-run the inventory and skip a changed row. Git removes a worktree containing only ignored
files without refusing, and a file written after approval was never presented to the user.

Remove the directory with `--force`. A working directory is normally dirty, and plain
`git worktree remove` refuses on modified or untracked files:

    git worktree remove --force $worktreePath

Treat a failed removal as damage, not as a clean refusal. Git does not refuse cleanly when a
file cannot be deleted, for example one held open on Windows: it removes what it can, including
tracked files, `.git`, and the registration, then fails. Stop the run and report rather than
continuing to the ref delete, because the branch-record check will now pass on a half-destroyed
worktree.

For a local row, confirm no `branch` record in `git worktree list --porcelain` names the
ref, then delete with the expected old SHA, which refuses a ref that moved after
presentation:

    git update-ref -d refs/heads/$name $approvedSha

The check and the delete are not atomic, so a worktree appearing between them still loses its
branch. Prefer the expected SHA: the graveyard recovers that branch, but not commits pushed
after presentation.

For a remote row, lease and delete the remote's `refs/heads/<name>`, not the
`refs/remotes/...` name the inventory carries:

    git push $remote "--force-with-lease=refs/heads/${name}:$approvedSha" --delete "refs/heads/$name"

Report every result. After a failed remote deletion, continue and include the error. Finish
with `git fetch <remote> --prune` and report how many refs remain.

## Recovery

The graveyard reflog retains each deleted tip for `gc.reflogExpireUnreachable`, 30 days by
default and not guaranteed. Recover one with `git branch <name> <sha>`, reading the SHA and
its original refname from `git reflog show refs/prune/graveyard`. The ref sits outside
`refs/heads`, so it never appears in `git branch`.

For unmerged work the user wants to keep longer, offer a bundle or a tag.

## Error handling

Every pull request query must exit successfully and return a complete, parseable result.
Treat a failed, unauthenticated, rate-limited, or truncated query as unknown. A failed
query and an empty result are not the same, and confusing them deletes branches with open
work.

Without `gh`, `az`, or an equivalent API, ancestry still identifies direct merges. Squash
and rebase merges cannot be established, so categorize those refs as unknown and say why
rather than inferring merge status from names or dates.
