# Separate policy from mechanism

Keep decisions about what should happen separate from the machinery that carries them out. Let the caller,
configuration, or the component that owns the policy make those choices. A mechanism should carry out its
instructions without adding preferences of its own.

For example, a file comparison engine should not exclude `.git` because its author thinks users should not
care about it. File selection is policy. Reading and comparing the selected files is the mechanism's job.
An exclusion can be a deliberate product default, but it belongs with the selection policy.

Distinguish preferences from constraints needed for safety or correctness. Explain the constraint and what
requires it; “users probably do not want this” is not a technical limitation. A choice can live beside the
mechanism when one component owns both; this principle does not require an option or abstraction for every
decision.

Test that the mechanism honors supported choices. Assert a particular policy in a test when it is a promised
product behavior, not merely because it is today's configuration.
