# OpenAI quota recovery

Interactive Pi tasks wait through OpenAI subscription usage limits and resume automatically
on the model selected at retry time. The extension recognizes
`subscription_sharing_usage_limit_exceeded` and legacy `openai-codex` ChatGPT usage-limit
wording. HTTP errors, `response.failed` SSE events, and data-only top-level SSE errors
are supported. Pi discards quota details from named `event: error` SSE frames before
extensions see them; those frames cannot trigger recovery. API billing exhaustion and
unrelated failures retain Pi's normal behavior.

The wait uses a provider reset time plus 30 seconds when available, or probes every
15 minutes otherwise. Legacy Codex reset hints are approximate. A static indicator
shows the countdown and “Press escape to cancel.” OSC7501 remains `working`; Pi owns
success, failure, and cancellation reporting. Notifications announce entry, successful
recovery, and timeout without repeating on every probe.

Enter steers the next request; follow-ups retain their normal queue order. Neither
input nor manual model selection advances the retry time. Pi's interrupt action cancels
waiting and recovery. Existing editor controls apply, including Vim's first Escape
leaving INSERT mode. Interrupt before `/reload`. Reload, session replacement, and exit
discard recovery state. Resumption uses the existing tool authorizations.

## Settings

Copy or link this directory to `~/.pi/agent/extensions/openai-quota-resume`, or load its
`index.ts` with `pi -e`. This repository's dotfiles installer links agent files according
to `install.conf.yaml`.

Configure the total recovery budget in user or trusted project `settings.json`:

```json
{
  "openaiQuotaResume": {
    "maxWaitMs": 18000000
  }
}
```

The default is five hours from the first quota failure. Repeated failures do not extend
it. `maxWaitMs` must be an integer from 1 to 2147483647; invalid values disable recovery
and produce a warning. The deadline stops recovery without a final probe. Queued user
messages otherwise follow Pi's normal handling when a run ends.

## Acceptance tests

From the repository root:

```sh
node --test pi/tests/quota-resume.acceptance.test.mjs
```

The suite loads the extension into the real Pi SDK with controlled time, isolated
settings, and hermetic providers. HTTP and SSE quota responses pass through Pi's real
OpenAI parser. The terminal sink records OSC7501 frames from Pi's status reporter.
Set `PI_SDK_ROOT` to a Pi package directory to exercise another installed version.

On Windows, `node pi/tests/quota-resume.pty.mjs` exercises the CLI in an isolated
psmux/ConPTY session, including Escape, reload, model selection, and terminal status.
It requires psmux, PowerShell, Pi, and the installed `pi-vim-editor` package. Captures
remain in the printed temporary directory.

Recovery holds `turn_end`, where Pi supplies its cancellation signal. It omits the failed
response from model context using a context edit, then requests continuation at
`agent_before_settle` when queued input has not already continued the task. No synthetic
user message or detached resume timer is used.
