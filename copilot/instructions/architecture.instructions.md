---
description: How to keep a system's shape sound - honest boundaries, one-way dependencies, and no bespoke framework or lava layer. Read before designing or restructuring.
applyTo: '**'
---

# Shaping a system

A system's shape is the set of decisions that are expensive to reverse: where the boundaries fall, which way the
dependencies point, what each part is allowed to know. One test runs under all of them: can you understand and
change one part without holding the rest in your head? Each section below is that test applied to a single
decision, and clean code cannot save a shape that fails it.

## Extend what exists; don't wrap it

Don't wrap a well-known library or SDK in a bespoke pass-through API just to rename it. Extend its own types
instead: a rename-wrapper is a second API the team learns on top of the one they know, hiding the tool's real
behavior behind your guess at it. A wrapper earns its keep only where it isolates a boundary you must defend, an
anti-corruption layer; short of that, use the native API. See Stannard, ["When DRY Goes Bad: The Bespoke Company Framework"](https://aaronstannard.com/dry-gone-bad-bespoke-company-framework/).

## Don't pave the lava layer

A lava layer is a second way of doing something added without retiring the first: two ORMs, three date types, a
half-finished rename left beside the old code. An abandoned migration is the common cause, but the helper you add
next to the one it was meant to replace is the same thing. Each multiplies how much of the past a reader must
hold in their head. When you add a way, finish removing the old one or flag it; don't pour a fresh layer and leave.

## Prefer a type to a primitive

A bare string, int, or tuple carries no rules, so every use has to remember what a valid one is and the compiler
checks none of it. When a value has an invariant, a non-empty email, a positive quantity, an amount tagged with
its currency, give it a type that enforces the invariant at construction. Then the rest of the code cannot hold
an illegal value, and no reader has to re-derive what counts as valid.

## Make a required order explicit

Temporal coupling hides a necessary order behind an API that doesn't show it: init before use, set this before
calling that, dispose in sequence. The caller has to carry the order in their head, and a reordering breaks with
no warning. Put the order in the types, a builder that hands you the next step, a constructor that takes what
init needed, so the wrong sequence won't compile.

## Boundaries and dependencies

A boundary earns its place by letting each side be reasoned about and changed without the other. Point
dependencies one way, toward the stable and the owned, and never in a cycle. When two parts must change in
lockstep, either they share an owner and belong together, or the boundary is in the wrong place. Give every piece
of state one owner, or a defined consistency rule where it genuinely has several; two unmanaged writers to one
truth is a race waiting to happen.
