# Delegation

`delegate` runs a child Pi session and returns its answer and a follow-up handle.
Call it through codemode as `tools.delegate(...)`. Each child has its own
conversation, extensions, provider setup, policy hooks, tools and virtual router.

## Enable

Pi discovers this directory when the dotfiles installer links it under
`~/.pi/agent/extensions`. To keep it disabled by default, add this exclusion to
that agent directory's `settings.json`:

```json
{ "extensions": ["-./extensions/delegation/index.ts"] }
```

Explicit command-line loading enables it for one Pi invocation. From this repository:

```sh
pi -e ./pi/agent/extensions/delegation/index.ts
```

`pi config` also manages extension exclusions. Use `/reload` after changing settings
in a running session.

## Use

```js
const result = await tools.delegate({
  prompt: "Read note.txt and return its contents.",
  systemPrompt: "Prefix file contents with CHILD:",
  tools: ["read"],
});
const next = await tools.delegate({
  handle: result.details.handle,
  prompt: "What did you read?",
});
const children = await tools.delegates({});
```

Text content contains the answer; `details.handle` identifies the child conversation.
`usage` reports newly recorded child tokens and estimated USD cost in Pi's native
format. Follow-ups exclude previously reported entries and pick up usage recorded
since the last result. Charges recorded after the final call remain unreported.
Pi adds this usage to the outer codemode result and the parent's totals, including when the script fails.
Failed or cancelled child calls still reject in codemode.
Only usage recorded by Pi is included; a provider may bill requests without reporting usage.

A child starts with the parent's selected provider/model unless `provider` or `model`
is supplied. Omitting `systemPrompt` or `tools` uses Pi discovery and settings.
Project discovery respects the parent's trust decision. Child UI requests use the
parent's available UI context.

When you switch parent branches, each child's next follow-up uses the checkpoint
saved on that branch. Children created later on another branch are absent from
discovery and reject follow-ups until you return to their branch. Switching branches
never replays child work. Usage totals include work on every branch without charging
previously reported usage again. Navigation is blocked while a delegation call or
its cancellation cleanup is still running.
Overlapping parent turns and navigation are unsupported
([Pi #9154](https://github.com/earendil-works/pi/issues/9154)).

Follow-ups accept only `handle` and `prompt`. Concurrent calls to the same child
are rejected. Cancellation stops the current turn and preserves the conversation;
it does not undo completed actions. Failed turns also keep their handles.
A child cannot accept a follow-up until its current turn and cancellation cleanup finish.

`delegates` returns `details.children` with each child's `handle`, initial `prompt`, and `status`:
`running`, `stopping`, `interrupted`, `completed`, or `failed`. Listing starts no work
and recovers handles when a first call is interrupted before returning its answer.
Cancellation before child creation leaves nothing to list.

## Reload and resume

For a persisted parent, handles survive `/reload` and exit/resume. Native child
session files live in a directory beside the parent file, named after that file
without `.jsonl`. Parent history stores the child references, initial configuration,
and usage cursors. Child files stay outside Pi's parent-session continuation candidates.
These files contain conversation data and should be protected like the parent session.

A follow-up loads the conversation into a fresh child runtime using the saved
provider/model, thinking level, and explicit prompt/tool choices. Discovery uses
current settings, extensions, parent trust, and credentials. Missing files, malformed
JSONL, broken checkpoints, and unavailable models fail the call. Restoration never
retries or replays work.
Parent shutdown stops and closes child runtimes. A turn left running at exit is
listed as `interrupted` when the parent resumes.

A `--no-session` parent keeps children in memory only. Its handles end at reload,
exit, or a completed parent tree switch. Canceled navigation preserves them.

## Authentication and compatibility

The adapter supports **Pi 1.2.0** and checks its private SDK layout before use.
Children share the parent's live credential store and use its API-key and OAuth
methods. Temporary overrides and account changes reach existing children. Parent
authentication failures stop child requests. Shared login and refresh writes reach
the backing store. This grants access to credentials across providers, including
refresh tokens.

Pi composes the child's transport, catalogs, configured headers and extension state.
Authentication contributes the parent's resolved auth headers; configured headers
come from the child. Request hooks belong to each session's own extensions.

`auth.ts` owns access to Pi's private fields and provider composer. It installs an
auth-composition hook on each fresh child runtime before provider registration.
`model-refresh.ts` waits for child refresh work to settle before a request, including
newer work that supersedes an awaited refresh. Cancelling that wait leaves SDK-owned
token persistence running. A public effective-credential-store accessor could replace
the private store read; the composition hook would still be needed.

## Verify

With Node 24, install the pinned development dependencies and run the checks:

```sh
cd pi
npm ci
npm run check
```

`check` runs Biome linting and format verification, strict TypeScript checking, and
the delegation tests against Pi 1.2.0. `npm run format` applies formatting. These
checks cover delegation source and tests; other extensions and live configuration
are outside their scope.

Set `PI_SDK_ROOT` to an installed Pi package directory to run `npm test` against
that installation instead. Typechecking always uses the pinned development SDK.

Acceptance tests exercise delegation through Pi's file loader, codemode and bundled
CLI. A synthetic provider supplies deterministic responses and rejects incorrect
credentials; Pi owns the sessions, history, tools and storage. These tests establish
that the extension works through the interfaces its callers use.

SDK compatibility tests exercise the adapter directly to catch changes in Pi's
private behavior. Separate workers let SDK background work finish before fixture
files are deleted. All tests use isolated configuration and synthetic credentials;
live use provides additional evidence about provider compatibility.
