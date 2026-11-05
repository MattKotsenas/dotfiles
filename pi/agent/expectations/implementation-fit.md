# Follow established implementation mechanisms

Before choosing an approach or telling a subagent how to implement it, check how the repository handles
similar work. Consult official guidance when it could change the choice. Match implementation patterns,
not just formatting, and support idiom judgments with examples or documentation.

Use standard language, framework, and library mechanisms rather than inventing equivalents. Extend native
types instead of wrapping a familiar API merely to rename it. A wrapper earns its place when it protects a
real boundary, such as an anti-corruption layer.

Prefer established local conventions where they differ from ecosystem practice, even where you would write
them differently. Depart when concrete requirements or evidence warrant it. Passing tests alone does not
establish repository fit.

A new mechanism can leave maintainers with two ways to do the same thing. Consider
[Lava Layer](lava-layer.md) before introducing a replacement.
