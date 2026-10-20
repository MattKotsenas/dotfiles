# Bookmarks

Save assistant responses for later reference or discussion of what you want more
or less of. Capture and browsing make no model calls.

## Capture

`/bookmark` targets the latest text-bearing assistant message on the current
branch. Choose **More of this**, **Less of this**, or **Save for reference**, then enter an
optional note. Enter saves an empty note; Escape cancels. **Choose earlier
response** selects another assistant message from the current branch.

Direct capture skips the dialogs:

```text
/bookmark less invented a distinction I never made
/bookmark more explained the timing change clearly
/bookmark saved revisit this explanation
```

Other arguments become a neutral bookmark's note. Direct capture also works in
print, JSON, and RPC modes. Capture requires the agent to be idle and leaves the
conversation and model context unchanged.

## Browse

`/bookmarks` lists captures across projects, newest first, with notes and response
previews. **View saved response** opens a separate overlay with the captured text
at the top. Arrows and PageUp/PageDown scroll, Home/End move to the ends, and
Enter/Escape close it. Source metadata follows the response text. **Delete**
requires confirmation. Browsing requires terminal mode.

**Resume from this response** resumes its session and selects the captured response's
branch without generating a branch summary. A notification identifies the selected
response; the conversation ends at that response so you can continue from there. Continuing there creates a new branch
when later messages already exist. Pi's normal session-switch hooks and project
trust handling apply.

## Storage

Each capture is a JSON file under `<agent-dir>/bookmarks/`, normally
`~/.pi/agent/bookmarks/`. `PI_CODING_AGENT_DIR` changes the agent directory.
The files contain the response text, kind, note, capture time, working directory,
and source session and entry IDs. They form the cross-session collection; browsing
reads this directory rather than scanning session history. In this dotfiles setup,
the data directory is outside the repository.

Captures survive reload, restart, branching, and source-session deletion. Original
conversation context requires the source session file. An ephemeral session can
still produce a durable snapshot, but its source is available only while that
session remains open. Unreadable or invalid records are reported during browsing;
other records remain available. Incomplete temporary files are excluded.

Treat this directory as private conversation data. Capture copies the full text
of one assistant message, including any sensitive content in it. Nothing is
uploaded automatically. Deleting a bookmark removes its capture file; it leaves
the original conversation intact. Review workflows can read the JSON files and
use their source references to recover context.

## Verification

From `pi/`, run `node --test tests/bookmarks.test.mjs` and `npm run check`.
The tests use isolated data directories and native Pi sessions, including
cross-session navigation and concurrent capture. They make no network requests.

On Windows, `node tests/bookmarks.pty.mjs` checks the saved-response overlay and
source navigation in a real terminal. It requires Pi, psmux, and PowerShell, uses
an isolated psmux namespace and synthetic session, and retains screen captures in
the printed temporary directory.
