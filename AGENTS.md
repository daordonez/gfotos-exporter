# Agent Instructions

## Project purpose

`gfotos-migrator` is a local TypeScript and Ink CLI that migrates Google Photos Takeout ZIP archives into an isolated macOS Photos library on an external APFS volume. It supports photos and videos, preserves migration state in SQLite, and provides a deliberate manual handoff to the user's main Photos library.

The primary requirement is safety: the migration workflow must never modify the main Photos library or enable iCloud Photos for the isolated library.

## Language and code standards

- Write all repository-authored content in English: source code, identifiers, comments, CLI output, logs, documentation, configuration, tests, and commit messages.
- Use TypeScript with strict, small, readable functions. Prefer explicit error handling and existing project abstractions.
- Keep changes focused. Do not introduce dependencies, frameworks, or broad refactors unless the task requires them.
- Do not log tokens, credentials, personal paths, media metadata, or other sensitive user data.

## Repository map

- `src/cli.tsx`: command dispatch and non-interactive commands.
- `src/tui.tsx`: guided interactive migration workflow.
- `src/takeout.ts`: ZIP inventory, safe extraction, and Google Takeout sidecar handling.
- `src/media.ts`: media metadata normalization and ExifTool integration.
- `src/migration.ts`: migration paths, hashes, import orchestration, and reporting inputs.
- `src/database.ts`: SQLite migration state.
- `src/photos.ts`: Apple Photos automation.
- `src/volume.ts`: APFS, capacity, and external disk validation.
- `docs/operations.md`: operator workflow and recovery.
- `docs/troubleshooting.md`: known failures and operator actions.
- `test/core.test.mjs`: native Node test suite.

## Safety invariants

- Treat Google Takeout archives and extracted originals as read-only input. Never alter originals in place.
- Import only into `GoogleTakeoutMigration.photoslibrary` on the selected external APFS volume.
- Never set the isolated library as the System Photo Library and never enable iCloud Photos in it.
- Do not automate imports into, deletion of, or configuration changes to the user's main Photos library.
- Keep the manual handoff explicit: it happens only after `handoff-check` and user review in Photos.
- Preserve SQLite state for imported, failed, skipped, and unknown items. Do not automatically retry `unknown` items because Photos may have accepted them before an interruption.
- Preserve SHA-256 deduplication unless a migration and recovery strategy is changed together.
- ZIP handling must remain resistant to path traversal and ZIP bombs. Do not buffer complete video files in memory.
- `prepare-volume` is destructive. It must accept only an external whole-disk identifier and require an exact, explicit confirmation of that identifier before invoking `diskutil eraseDisk`.
- `cleanup` must require the exact isolated-library confirmation and must never accept a broad path or the main library.

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
