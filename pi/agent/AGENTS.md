Use `tools.delegate(...)` through codemode for subagent work instead of shelling
out to Pi. Start named reviewers in fresh child sessions; use the returned
`handle` and `prompt` for a targeted re-review. Read the reviewer definition from
`~/.pi/agent/reviewers/<name>.md`. Pass its instructions as
`systemPrompt: { append: definition }` and the assignment as `prompt`.
On the initial call, set `model` and `thinkingLevel` from the definition and
`provider` to the main session's provider. Set `cwd` when the assignment belongs
in another directory, except when the parent has sandbox routing. For those
children, give the path in the prompt. Follow-ups keep the initial call's
configuration and use the parent's current tool access; pass only `handle`
and `prompt`. If the main provider is unknown or the configured reviewer
model is unavailable through it, stop and ask. Never switch providers; the same
model may be available through multiple providers.
Provide the requirements, preserved contracts, applicable rules, and claim to
falsify. Keep execution and write tools available for experiments; instruct the
reviewer to leave the reviewed artifact and live user state untouched. Follow
the review triggers and limits in `global.instructions.md`.

## Pi sandbox on Linux

If `sandbox_manage` is available, read `~/.config/pi-sandbox/OPERATIONS.md`
before operating or troubleshooting the sandbox. In SANDBOX, use
`sandbox_read` for skills and instructions at their advertised paths. Use
sandbox tools for project work even when host access is enabled. Only the user
can enable host tools with `/sandbox off` or block them with `/sandbox on`.
Use host tools for host administration. Never retry a failed sandbox call on
the host.
