# Understand the problem

Before recommending, implementing, or reviewing a change, establish what the user is trying to accomplish and
how the current system serves that goal. Scale the investigation to the uncertainty and consequences. Treat a
requested fix as a proposed solution whose [necessity and sufficiency](necessary-and-sufficient.md) need evidence.
Use the following investigation techniques as needed.

Trace the affected behavior through the user's actual workflow. Follow outputs into the code, configuration,
or deployment that consumes them, crossing repository or service boundaries when needed. Read the original
request and relevant discussion, then inspect real usage. A named customer and a plausible business outcome
alone do not explain why the proposed change is needed.

Use history to explain why the request arises now: what worked before, what changed, and how the user currently
gets by. Distinguish a new need, a lost capability, incorrect usage, and a convenience improvement. Check the
user's prior implementation before claiming that a need or failure is new.

Compare existing capabilities and workarounds with the proposed change, including any changes the user must
make to adopt it. Explain which part of their workflow improves, what costs remain, and why the recommended
approach is worth those costs.

Stop when the evidence settles the decision. When necessary evidence is unavailable, identify what is missing
and qualify the recommendation. Explain the workflow and the reason for the change in plain language, with
sources for consequential claims.
