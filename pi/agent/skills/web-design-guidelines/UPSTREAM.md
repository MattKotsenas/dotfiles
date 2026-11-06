# Upstream

Source: [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/skills/web-design-guidelines), commit `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62`.

The [upstream README](https://github.com/vercel-labs/agent-skills/blob/1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62/README.md#license)
declares MIT without license text or a copyright notice; the upstream skill
directory contains only `SKILL.md`. `LICENSE` reproduces the standard MIT
permission and warranty text from [SPDX](https://spdx.org/licenses/MIT.html); no copyright
holder or year is invented.

The Pi adaptation adds the license field and replaces the unavailable
`WebFetch` step with an available web tool or a checked HTTPS download to a
temporary file. A failed fetch blocks the review rather than implying compliance.
The guideline URL stays upstream-owned and is fetched fresh for each review;
pinning this skill does not pin the guidelines it retrieves.
