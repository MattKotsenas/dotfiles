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
in a running session. Reload discards this extension's child handles.

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

> [!WARNING]
> Follow-up fields beyond `handle` and `prompt` are not supported yet.
>
> Completed-conversation restoration and parent rewind are not supported yet.
> Handles advance the same conversation and last until parent reload or exit.

Concurrent calls to the same child are rejected. A failed call closes the child and
invalidates its handle. Parent shutdown closes its children.

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

From the repository root, with Node 24 and an installed Pi package:

```powershell
$env:PI_SDK_ROOT = 'C:/path/to/node_modules/@earendil-works/pi-coding-agent'
node --test pi/tests/delegation.*.test.mjs
```

Acceptance tests exercise delegation through Pi's file loader, codemode and bundled
CLI. A synthetic provider supplies deterministic responses and rejects incorrect
credentials; Pi owns the sessions, history, tools and storage. These tests establish
that the extension works through the interfaces its callers use.

SDK compatibility tests exercise the adapter directly to catch changes in Pi's
private behavior. Separate workers let SDK background work finish before fixture
files are deleted. All tests use isolated configuration and synthetic credentials;
live use provides additional evidence about provider compatibility.
