# Documentation

## Follow the reader's task

Organize the document around what the reader needs to do or understand. A tutorial teaches through a complete
example; a how-to helps the reader finish a task; an explanation develops understanding; reference material
supports precise lookup.
Combine these only when the reader benefits, and keep advanced details from interrupting the main task.

State the problem or outcome before implementation details. Introduce prerequisites before the reader needs
them. Explain terms before relying on them. Give instructions in execution order, show the expected result,
and explain how to interpret failures and recover where relevant.

Read the draft as a user following only the documentation. Do not silently fill gaps with implementation
knowledge. A step that works only because you supplied an undocumented prerequisite needs an explanation or
a link. Distinguish such teaching gaps from claims contradicted by the implementation.

## Describe the present

Write living documentation in timeless present tense. Avoid "previously", "now", and "as of" when they merely
record editing history. Keep history when it serves the reader, such as a compatibility boundary or migration
instruction. Use the change-description reference for release notes and other historical artifacts.

Name the actor, operation, inputs, defaults, and observable consequences that matter. Describe opt-in behavior,
limitations, failure paths, and recovery alongside the affected operation. Do not imply support for an API,
language, platform, or version without evidence.

## Examples and references

Use realistic examples with the imports, variables, configuration, and context needed to follow them. Identify
partial snippets and show where they belong. Keep names consistent across examples. Prefer current recommended
APIs and safe defaults; explain development-only shortcuts where they are necessary.

Show the variants needed by the page's intended audience and supported behavior. Verify each demonstrated API
exists; do not invent a translation to another language. Explain actual capability differences without treating
one language or runtime as the universal default.

Use the repository's existing components, link syntax, version conventions, and navigation structure. Link to
the relevant explanation or exact API when it helps the reader. Do not link every mention or repeat reference
content in the guide. Check destinations and section anchors. Update navigation and redirects when a page moves
or is added, as the repository requires.

Use accessible headings, meaningful link text, and useful alternative text for informative images. Avoid idioms
and culturally specific assumptions. Use unambiguous dates and specify time zones when they affect the meaning.

## Verify what the reader receives

Check factual claims against authoritative sources for the documented version, then follow the instructions
literally in an appropriate test environment. Build and run affected code examples and execute documented
commands. Check observable results, including the negative paths the text claims to explain.

Inspect rendered pages when rendering matters: headings, code blocks, callouts, tables, tabs, links, and
navigation. Use existing repository tools and targeted checks appropriate to the change; a production build or
browser automation is not universally required. When changing a shared component or interaction, run the tests
that cover its affected behavior under the existing testing instructions.

Report what could not be verified and why when it affects confidence in the documentation. Do not equate
source inspection, successful compilation, and observed runtime behavior.
