# Necessary and sufficient

A change should do everything the task needs and nothing it does not. This applies to scope, implementation,
tests, and prose. Every extra mechanism costs readers effort to understand, review, and maintain.

Finish the job: remove imports, helpers, callers, configuration, and tests your change makes obsolete.
Leave unrelated code alone, even when you see an improvement. Mention pre-existing dead code rather than
silently deleting it.

Write the leanest implementation that meets the task. Avoid speculative machinery and abstractions between
things that merely resemble each other. Keep one check per concern at a boundary; independent trust or
concurrency boundaries can require separate checks. Understand what a guard or abstraction protects before
removing it.
