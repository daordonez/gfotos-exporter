# GitHub Copilot Instructions

## Repository objective

`gfotos-migrator` is a local TypeScript and Ink CLI. It processes Google Photos
Takeout data locally and must protect user media and user-selected destinations.

Read the assigned issue, `AGENTS.md`, and the relevant source, tests, and
documentation before editing. The issue is the implementation contract: do not
infer missing requirements, broaden its scope, or silently change its branch
strategy.

## Reconciling issue requirements

An issue can explicitly supersede an existing behavior, architecture decision,
or document. When it does, apply that change only within the issue's stated
scope and update the affected contract, tests, and documentation together. Do
not infer a supersession from a title or an incomplete description.

No issue may relax these guarantees without explicit human authorization:

- Treat Takeout archives, extracted originals, and sidecar JSON as read-only
  inputs.
- Preserve SHA-256 deduplication and provenance unless the issue explicitly
  changes both the contract and recovery strategy.
- Do not expose credentials, tokens, personal paths, or media metadata in logs,
  reports, pull requests, or issue comments.
- Do not claim a manual check, external-volume behavior, real Takeout result,
  Photos behavior, or iCloud behavior that was not actually performed.
- Do not perform destructive disk, library, or source-media operations.

## Implementation and validation

- Use strict, small, readable TypeScript. Reuse existing abstractions and do
  not add dependencies without an issue requirement.
- Keep the Node native test runner. Do not introduce Vitest globals or change
  `tsconfig.json` to add non-Node ambient types.
- Update focused tests, `README.md`, `docs/operations.md`, and
  `docs/troubleshooting.md` when the issue affects their documented behavior.
- Run the applicable commands from the repository root before requesting
  review:

  ```sh
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm test
  pnpm pack:local
  ```

- Report each acceptance criterion as verified, not verified, or requiring a
  manual check. Include the command evidence and limitations in the pull
  request description.

## Git and delivery

- Never push to `main`, merge a pull request, create a release, or alter
  repository settings.
- Follow the branch base and pull-request target specified by the assigned
  issue. Use the repository's normal feature-branch convention only when the
  issue does not define a different integration strategy.
- Do not modify unrelated files or overwrite concurrent work.
- Treat changes under `.github/` as security-sensitive. Preserve least
  privilege and use fully pinned GitHub Actions.
