---
description: How to change code without bloating it - write the least code that works, extend libraries instead of wrapping them, and keep names honest. Read before editing source.
applyTo: '**'
---

# Changing code

Every line you add is a line the team reads, reviews, and maintains after you have moved on. Spend them
sparingly: the smallest change that fully solves the problem is also the easiest to review and the cheapest to
keep.

## Write the least code that solves it

[Necessary and sufficient](global.instructions.md#2-necessary-and-sufficient) applies to the code you write,
not just the scope you touch: write the leanest version that does the job. If a 200-line solution could be 50
lines, write the 50.

Over-building for a future that may not arrive is the expensive mistake, and belt-and-suspenders is its most
common form. When a problem is already handled, a second guard for the same concern is another mechanism every
reader has to reconcile with the first, rarely sure which one matters. Keep one check per concern, unless a
second guards a real trust boundary.

## Extend what exists; don't wrap it

Don't build a bespoke abstraction around a well-known library or SDK. Extend its own types instead. A wrapper
is a second API the team has to learn on top of the one they already know, and it hides the tool's real
behavior behind your guess at it. When you catch yourself writing `IFooRunner` around a library's native API,
stop and use the API.

See Stannard, ["When DRY Goes Bad: The Bespoke Company Framework"](https://aaronstannard.com/dry-gone-bad-bespoke-company-framework/).

## Rename when the meaning drifts

When a change moves what a component does, move its name with it. A name that has drifted from its behavior
(`HumanCommand`, once machines send it too) misleads every reader who trusts it, and the cost compounds with
every new caller. If the rename is genuinely out of scope, flag it rather than leaving the lie in the code.
