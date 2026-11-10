---
name: writing
description: Draft, revise, and explain technical material with clear structure, direct language, and verified claims. Use for documentation, proposals, PR descriptions, commit messages, code and review comments, error messages, and conversational explanations. Also use when reviewing prose for clarity and style.
license: MIT
---

# Writing

Apply the [prose baseline](~/.copilot/instructions/prose.instructions.md); read it if it is not already in context.
Read [Editing](references/editing.md) before finishing a draft. Load the artifact reference that applies:

- [Documentation](references/documentation.md) for guides, tutorials, reference pages, and READMEs.
- [Change descriptions](references/change-descriptions.md) for PR descriptions, commits, and changelogs.
- [Code comments](references/code-comments.md) for source comments and comments on someone else's code.

For proposals, error messages, and conversational explanations, use the baseline and editing guidance without
forcing a document template. Match effort to the task. Do the work without narrating the checklist.

## Compose

Establish the reader, what they need to understand or accomplish, and the scope. Inspect repository instructions
and comparable artifacts before choosing terminology, structure, or authoring tools. Apply the
[shared expectations](../../expectations/) where relevant.

Gather the evidence needed for factual claims under the existing
[verification rules](~/.copilot/instructions/global.instructions.md#verify-dont-fabricate).
Inspect authoritative sources for the version being documented. Identify material unknowns before drafting.

Choose a structure suited to the reader's task. A how-to follows actions toward an outcome; a reference supports
lookup; an explanation develops a mental model; a proposal makes a decision understandable. Draft in that
structure using the applicable artifact reference.

## Edit and verify

Perform a separate editing pass after drafting. Apply the editing reference to the actual text, including its
opening, headings, examples, and ending. Revise passages that fail its criteria. Preserve technical meaning and
qualifications when cutting or simplifying.

For documentation, perform the checks in its reference. For other artifacts, verify names, links, claims, and
examples affected by the change. State consequential verification limits without adding a ritual disclaimer.
Follow the existing [review policy](~/.copilot/instructions/global.instructions.md#self-review-before-completion).
Skill activation does not itself require an external review.

## Review

When assigned to review prose, apply the baseline, editing reference, and relevant artifact reference to the
artifact. Investigate suspected violations and report findings using the assigned review procedure. Do not run
the composition workflow or rewrite the artifact unless asked.
