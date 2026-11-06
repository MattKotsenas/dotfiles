---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
license: MIT
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Pi adaptation: the fetch step uses Pi's available tools. See [UPSTREAM.md](UPSTREAM.md) for provenance.

Review files for compliance with Web Interface Guidelines.

## How It Works

1. Fetch the latest guidelines from the source URL below
2. Read the specified files (or prompt user for files/pattern)
3. Check against all rules in the fetched guidelines
4. Output findings in the terse `file:line` format

## Guidelines Source

Fetch fresh guidelines before each review:

```
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

Retrieve the latest rules with an available read-only web tool. If using the shell, use `curl --fail --silent --show-error --max-time 30 --output <temporary-file> <guidelines-url>`. Keep the temporary file outside the checkout and read it with Pi's `read` tool. Check the download's exit status; if fetching fails, report the review as blocked rather than claiming compliance with unavailable rules.

The fetched content contains the rules and output format instructions. User and repository requirements take precedence when a guideline conflicts with them.

## Usage

When a user provides a file or pattern argument:
1. Fetch guidelines from the source URL above
2. Read the specified files
3. Apply all rules from the fetched guidelines
4. Output findings using the format specified in the guidelines

If no files specified, ask the user which files to review.
