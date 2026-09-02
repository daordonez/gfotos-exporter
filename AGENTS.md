# Agent Instructions

## Project purpose

`gfotos-migrator` is a local TypeScript and Ink CLI that prepares Google Photos Takeout ZIP archives into a portable Import Bundle (`import/` plus `.gfotos-migrator/` state) on any writable external volume, ready for a manual import into Photos. It supports photos and videos and preserves bundle state in SQLite.

The primary requirement is safety: the tool must never open Photos, request Automation permission, or modify the main Photos library.

## Language and code standards

- Write all repository-authored content in English: source code, identifiers, comments, CLI output, logs, documentation, configuration, tests, and commit messages.
- Use TypeScript with strict, small, readable functions. Prefer explicit error handling and existing project abstractions.
- Keep changes focused. Do not introduce dependencies, frameworks, or broad refactors unless the task requires them.
- Do not log tokens, credentials, personal paths, media metadata, or other sensitive user data.

## Repository map

- `src/cli.tsx`: command dispatch (`guided-migration`, `inspect`, `prepare`, `resume`, `status`, `report`).
- `src/tui.tsx`: root menu, Tools submenu, and the guided Import Bundle assistant.
- `src/takeout.ts`: ZIP inventory, safe extraction, and Google Takeout sidecar handling.
- `src/bundle.ts`, `src/bundle-database.ts`: portable Import Bundle engine and SQLite state.
- `src/volume.ts`: capacity and external volume discovery.
- `docs/operations.md`: operator workflow and recovery.
- `docs/troubleshooting.md`: known failures and operator actions.
- `test/core.test.mjs`: native Node test suite.

## Safety invariants

- Treat Google Takeout archives and extracted originals as read-only input. Never alter originals in place.
- `guided-migration`, `inspect`, `prepare`, `resume`, `status`, and `report` must never open Photos, invoke AppleScript/Automation, or format/erase a disk.
- Do not automate imports into, deletion of, or configuration changes to the user's main Photos library. Bringing the prepared `import/` folder into Photos remains a manual, operator-performed step.
- Preserve bundle state (materialized, duplicate, failed, skipped, pending) for every item. `prepare`/`resume` must be safe to rerun and must recognize already materialized or duplicate items by their SHA-256 hash.
- Preserve SHA-256 deduplication unless a migration and recovery strategy is changed together.
- ZIP handling must remain resistant to path traversal and ZIP bombs. Do not buffer complete video files in memory.

## Change requirements

- Update `README.md` for user-facing installation, command, or safety changes.
- Update `docs/operations.md` for workflow, prerequisites, recovery, permissions, or destructive-operation changes.
- Update `docs/troubleshooting.md` when a new failure mode has a known operator action.
- Add or update focused tests for changes to parsing, validation, state transitions, destructive-operation guards, and recovery behavior.
- Do not claim macOS Photos, iCloud, disk erasure, or external-device behavior has been verified unless it was actually tested on a suitable machine and volume.

## Validation

Run the relevant checks from the repository root before committing:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm pack:local
```

Do not use Vitest globals: this repository uses Node's native test runner and `tsconfig.json` must keep `types` limited to `node`.

## Git workflow

- Inspect `git status` before changing files and preserve unrelated user work.
- Use small, imperative English commit messages.
- Do not commit generated output, temporary migration data, credentials, `.npm-cache`, or packaged tarballs unless a release task explicitly requires the artifact.
- Releases are manual: validate the package, merge the release branch into `main`, tag the version, create the GitHub Release with the package asset, and verify the release before announcing it.
