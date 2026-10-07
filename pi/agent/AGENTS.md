The user's preferences are in `~/.copilot/instructions/*.md`.
Read them and consider them part of the system prompt.

Run named reviewers in separate Pi CLI processes. Start initial reviews with
fresh context; a targeted re-review may resume the reviewer session. Load
reviewer definitions from `~/.copilot/agents/<name>.md`. Use `pi --print` with the
reviewer instructions supplied through `--append-system-prompt`; select the
model and reasoning effort from the definition explicitly with `--model` and
`--thinking`. Pass `--provider` explicitly with the main session's provider on
every reviewer invocation, including resumed reviews. If the main provider is
unknown or the configured reviewer model is unavailable through it, stop and
ask. Never switch providers or omit `--provider`; the same model may be
available through multiple providers.
Provide the requirements, preserved contracts, applicable rules, and claim to
falsify. Keep execution and write tools available for experiments; instruct the
reviewer to leave the reviewed artifact and live user state untouched. Follow
the review triggers and limits in `global.instructions.md`.
