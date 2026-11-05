# Make illegal states unrepresentable

Put validity rules in types so callers do not have to remember and recheck them.

For values, enforce invariants at construction: a non-empty email, a positive quantity, or an amount tagged
with its currency. Using bare primitives for domain values with these rules is often called primitive obsession.
Not every primitive needs a new type.

For operations that must happen in order, make the API show that order. A constructor can take the data needed
for initialization; a builder can return a type that exposes only the next valid steps. Where the language
permits, make invalid sequences fail to compile.

These techniques keep invalid values and operations out of the rest of the code. Apply them to actual domain
rules and required ordering, not incidental implementation sequences.
