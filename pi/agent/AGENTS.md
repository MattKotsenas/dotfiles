Use `tools.delegate(...)` through codemode for subagent work instead of shelling
out to Pi. Start named reviewers in fresh child sessions; use the returned
`handle` and `prompt` for a targeted re-review. Read the reviewer definition from
`~/.copilot/agents/<name>.md`. Pass its instructions as
`systemPrompt: { append: definition }` and the assignment as `prompt`.
On the initial call, set `model` and `thinkingLevel` from the definition and
`provider` to the main session's provider. Set `cwd` when the assignment belongs
in another directory. Follow-ups keep the initial call's configuration; pass only
`handle` and `prompt`. If the main provider is unknown or the configured reviewer
model is unavailable through it, stop and ask. Never switch providers; the same
model may be available through multiple providers.
Provide the requirements, preserved contracts, applicable rules, and claim to
falsify. Keep execution and write tools available for experiments; instruct the
reviewer to leave the reviewed artifact and live user state untouched. Follow
the review triggers and limits in `global.instructions.md`.
