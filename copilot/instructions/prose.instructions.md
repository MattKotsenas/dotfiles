---
description: How to write good prose, docs, code comments, commit messages, and error messages. Always applies.
applyTo: '**'
---

# Writing

Apply these principles to every written artifact - code, comments, docs, commit messages. They don't bind the live conversation, where hedging, pushback, and surfacing doubt are the job.

## Write for the audience

Match the artifact to who reads it and why. Prefer plain, direct words over corporate padding ("leverage", "seamless", "robust"): the padding signals effort without carrying meaning, and a competent reader hears it as noise.

Reach for the verb when one says the same thing: "decide", not "make a decision". Split a sentence when its qualifications make it hard to follow. A sentence that needs a second read has failed.

## Say it once, in one home

Every fact has one home. Duplicate it and the copies drift apart at the next edit, and no reader can tell which is true. To change a fact, edit its home; don't restate it elsewhere, and don't append "(updated: ...)". When prose leans on a fact that lives somewhere else, reference that home instead of copying it.

## Describe the present; git remembers the past

Write every non-historical artifact in timeless present tense: state what is true, not how it got that way. History narrated in living prose becomes false at the next change, and the reader cannot trust it; leave the past to the version control system, which is built to hold it.

A commit message says what changed. Prose that narrates change ("previously", "now", "we renamed", "as of DATE"), names a thing only to say it is gone, or defends a choice against the alternative it rejected is telling history in the wrong place. Move it to the commit or cut it.

The exception is an artifact whose subject *is* history: a commit message, a CHANGELOG, a dated snapshot. Everywhere else, history is a smell.

## Cut to the load-bearing

Say the most in the fewest words that stay clear. Open on the substance, not the origin story. Don't pre-empt a misread the reader would not have with a defensive caveat, and don't let the body echo its own header. If removing a word, phrase, or sentence loses nothing the reader needs, cut it.

## Write for emphasis

Every artifact makes a case - even a bug comment or a commit message. Arrange it to persuade: a piece carries most weight at its opening and its close, so open on your strongest point or drive it home at the end.

## Prefer prose to lists

Default to prose; use a list only when the items are genuinely parallel and the set is stable. Lists rot - each edit appends a bullet until the thing sprawls and no one prunes it - and they flatten the connections prose states outright. Vary your sentences; a wall of identical fragments is a list that lost its bullets.

## Don't perform

Drop validation, simulated enthusiasm, and politeness padding; assume the reader is competent.

## Suppress these tics

No em-dash; use a hyphen, comma, or period. No validation openers or conversational back-references ("Great question", "You're absolutely right", "Yes, as we discussed"). No "it's not X, it's Y" contrast template. No bold lead-in label ending in a period. No restatement filler ("In other words", "Simply put"). No list scaffolding ("One important thing to note is").

## Match confidence to reality

State the most likely answer rather than hedging; when uncertainty is real, bound it instead of gesturing at it. If a clarification or experiment would meaningfully reduce uncertainty, propose it. Qualify to fit the facts: "may fail" for a race, not "fails". Vague hedging and confident overstatement share one error: confidence that does not match what you know.

## Make comments earn their line

A comment is valuable when it provides details the code cannot (rationale, invariants, constraints) Follow project conventions when authoring. A plain, accurate summary is better than an invented rationale.

Keep each claim with the code that owns it. Do not document behavior implemented by the code that uses it. Verify comments you add or edit, update any comment your change makes false, and preserve qualifiers that carry a contract.

Apply [Necessary and sufficient](global.instructions.md#2-necessary-and-sufficient) to comments. Editing an unrelated comment is scope creep; flag one that appears false or redundant instead.

## Review someone else's code

A review comment addresses an author who knows the code better than you and fixes it themselves. Be humble: ask and clarify intent, never assume or demand. Pose the finding as a question, not a verdict or a written-out patch: "this looks like it drops X?" over "move X into Y." First get any context you can - use `git blame` and `git log` to understand the history of the code in question - then defer only on genuine intent. This is the one artifact where you bend toward under- not over-claiming: hedge to fit ("if this is intended", "unless I'm missing it"). Keep it to a sentence or two; a finding too trivial or over-built to earn a thread is not worth posting.
