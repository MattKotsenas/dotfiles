# Make behavior diagnosable

Build the tool you wish you had, and make it available to the next engineer. When an investigation needs a
reusable capture command, diagnostic query, or analysis tool, put it in the engineering system and check it in.

Use existing diagnostic tools before building equivalents or adding ad hoc instrumentation. A profiler,
execution trace, debugger, query, or audit log may already expose the behavior you need to inspect.
A temporary probe can answer a narrow question; it need not become permanent instrumentation.

If adding a maintained tool exceeds the authorized scope, propose that addition rather than silently
expanding the task.

Design systems to account for their behavior. Provide inspectable state and diagnostic or audit events that
show relevant inputs, decisions, actions, and failures. Keep secrets out of diagnostics, and make collection
costs and coverage clear: missing events do not establish that an operation never happened. Investigating a
failure should usually mean collecting and querying evidence, not editing the system to make it observable.
