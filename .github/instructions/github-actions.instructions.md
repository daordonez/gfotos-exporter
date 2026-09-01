---
applyTo: ".github/workflows/**/*.yml,.github/workflows/**/*.yaml"
---

# GitHub Actions Instructions

Use the least permissions necessary at workflow or job level. Pin third-party
actions to full commit SHAs. Do not expose or add secrets to ordinary CI jobs.

For pnpm workflows, install the pinned `pnpm/action-setup` action before the
pinned `actions/setup-node` action and keep the Node version aligned with
`package.json`. Preserve the repository validation sequence unless an issue
explicitly changes it.

Do not change release behavior, branch-protection assumptions, or workflow
permissions merely to make a check pass. Explain every permission expansion in
the pull request and validate workflow syntax and the local package commands.
