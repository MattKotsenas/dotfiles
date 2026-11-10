# Change descriptions

PR descriptions, commit messages, and changelog entries describe a change. Follow the repository's conventions
for each; do not apply living documentation's present-tense rule as a ban on explaining a transition.

## Pull requests

Start with the user-visible outcome the PR makes true. Follow with changes to compatibility or defaults that
users must account for, then the implementation details needed to understand or review the change.

Explain the reason for the change and consequential tradeoffs. Describe validation precisely, distinguishing
checks actually run from expected behavior and naming meaningful gaps. Reference supporting evidence instead
of reproducing investigation transcripts. Do not claim every step of a workflow works because its components
passed separate tests.

Keep the description aligned with the actual diff. Do not turn proposed follow-up work into a delivered
capability or hide a behavior change in an implementation summary.

## Commit messages

Match the repository's subject style and summarize the logical change. Use a body when the motivation,
constraint, or consequence is not evident from the subject and diff. Avoid a file-by-file inventory that
adds no explanation. Git operations remain governed by the existing git skill and global instructions.

## Changelogs and release notes

State what users gain or must change. Identify affected versions, defaults, compatibility boundaries, and
migration actions when relevant. Separate shipped behavior from previews and plans. Preserve historical
version information when it is part of the record.
