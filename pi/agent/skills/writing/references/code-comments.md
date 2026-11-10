# Code comments

## Comments in source

Make each comment earn its line. Explain rationale, invariants, or constraints the code does not express.
Follow repository conventions.

Document guarantees where they are enforced. For example, document a caller's retry policy at the caller.
Verify comments you add or edit and update comments your change makes false. Preserve conditions such as
"only after initialization" when they limit what a comment promises.

Apply [Necessary and sufficient](../../../expectations/necessary-and-sufficient.md) to comment changes.
Flag an unrelated comment that appears false or redundant rather than silently expanding the edit.

## Comments on someone else's code

Address an author who knows the code better than you. Investigate before posting: inspect surrounding code,
tests, and history using `git blame` and `git log` under the existing git guardrails. Ask the author about
intent you cannot establish from the code or history.

Ask about the demonstrated consequence, grounded in the author's actual change and the applicable contract.
Pose the finding as a question, not a verdict or a written-out patch: "This looks like it drops X?" rather
than "Move X into Y." Qualify uncertainty where it is real, using wording such as "unless I'm missing it" or
"if this is intended". Keep the comment to a sentence or two; omit findings too trivial to earn a thread.
