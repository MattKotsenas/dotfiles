# Avoid Lava Layer

[Mike Hadlow's “The Lava Layer Anti-Pattern”](https://mikehadlow.blogspot.com/2014/12/the-lava-layer-anti-pattern.html)
describes how successive improvements can leave several ways of doing the same thing scattered through a
codebase. Consistent older code can be easier to maintain than a partly adopted replacement.

Before refactoring, identify what the new implementation replaces and which behavior must stay the same.
Verify that behavior before finishing, and remove the old implementation along with callers, configuration,
and tests that no longer serve a purpose.

If both implementations must remain, explain why. If one is temporary, say when it can be removed.
If the addition replaces nothing, explain what it enables that the existing code cannot do.
