# Agent Instructions

## Project purpose

`gfotos-migrator` is a local TypeScript and Ink CLI that prepares a Google Photos Takeout export as a portable **Import Bundle**: a flat `import/` directory of deduplicated original photos and videos plus a `.gfotos-migrator/` state directory (SQLite state, extracted sidecar metadata, manifest, and reports) on any writable destination volume. It supports photos and videos, preserves bundle state and provenance in SQLite, and leaves the final import into Photos (or any other tool) as a deliberate manual step.

The primary requirement is safety: bundle preparation must never modify Takeout inputs, never touch Photos or iCloud, and never perform destructive disk operations. `guided-migration` remains the complete, stable end-to-end assistant for this workflow.

## Language and code standards

- Write all repository-authored content in English: source code, identifiers, comments, CLI output, logs, documentation, configuration, tests, and commit messages.
- Use TypeScript with strict, small, readable functions. Prefer explicit error handling and existing project abstractions.
- Keep changes focused. Do not introduce dependencies, frameworks, or broad refactors unless the task requires them.
- Do not log tokens, credentials, personal paths, media metadata, or other sensitive user data.

## Repository map

- `src/cli.tsx`: command dispatch and non-interactive commands (`guided-migration`, `inspect`, `prepare`, `resume`, `status`, `report`).
- `src/tui.tsx`: guided interactive Import Bundle workflow, including the root menu and Tools submenu.
- `src/takeout.ts`: ZIP inventory, safe extraction, and Google Takeout sidecar handling.
- `src/bundle.ts`: bundle paths, volume writability/capacity checks, manifest handling, and bundle preparation orchestration.
- `src/bundle-database.ts`: SQLite Import Bundle item state.
- `src/domain.ts`: shared domain types (media candidates, bundle paths/items/manifest, Takeout inventory).
- `src/volume.ts`: external volume discovery and inspection (filesystem-agnostic; no APFS or disk-erase requirement).
- `docs/operations.md`: operator workflow and recovery.
- `docs/troubleshooting.md`: known failures and operator actions.
- `test/core.test.mjs`: native Node test suite.

## Safety invariants

- Treat Google Takeout archives and extracted originals as read-only input. Never alter originals in place.
- `import/` must stay flat and contain only final media files; tool-created state lives only under `.gfotos-migrator/`.
- Do not automate opening, importing into, or configuring Photos, and do not request macOS Automation permission. The manual import into Photos (or any tool) happens only after the operator reviews the completed bundle.
- Preserve SQLite bundle state and provenance (source archive, entry, SHA-256, final path, state) for materialized, duplicate, failed, skipped, and pending items.
- Preserve SHA-256 deduplication unless a bundle contract and recovery strategy is changed together.
- ZIP handling must remain resistant to path traversal and ZIP bombs. Do not buffer complete video files in memory.
- Do not reintroduce APFS-only validation or destructive disk formatting/erasure in the bundle preparation path; accept any writable destination with sufficient free capacity.

## Change requirements

- Update `README.md` for user-facing installation, command, or safety changes.
- Update `docs/operations.md` for workflow, prerequisites, recovery, permissions, or destructive-operation changes.
- Update `docs/troubleshooting.md` when a new failure mode has a known operator action.
- Add or update focused tests for changes to parsing, validation, state transitions, destructive-operation guards, and recovery behavior.
- Do not claim macOS Photos, iCloud, disk erasure, or external-device behavior has been verified unless it was actually tested on a suitable machine and volume.
- Do not claim a manual Photos import or a real Takeout dataset was verified unless it was actually performed.

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
