# MVP checkpoint: 1.5.x

Status: achieved

The 1.5.x release line establishes the minimum viable product checkpoint for `gfotos-migrator`. Version 1.5.0 delivered the portable Import Bundle workflow. The following patch adds a clean `Exit` action to the main TUI menu and completes the baseline operator experience.

## Demonstrated product outcome

Given one or more Google Photos Takeout ZIP archives, the tool can:

- inventory supported photos, videos, and sidecar metadata without modifying the source archives;
- prepare or resume a portable Import Bundle on a writable destination with enough free capacity;
- materialize deduplicated original media under `import/`;
- preserve manifest, SQLite state, provenance, sidecars, metadata results, and reports under `.gfotos-migrator/`;
- expose the workflow through `guided-migration` and equivalent non-interactive commands;
- report completion and provide an explicit manual handoff path; and
- close the TUI from the main menu without requiring an interrupt signal.

## Safety boundary

The MVP does not automate Photos import, modify a Photos library, change iCloud settings, format disks, or alter Google Takeout archives. Import into Photos or another destination remains an explicit operator action after bundle review.

## Acceptance baseline

The checkpoint is accepted when the repository passes:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm pack:local
```

Real Google Takeout data and destination-device behavior must be validated separately. Automated checks do not prove every archive variant, filesystem, or downstream importer.

## Versioning

The TUI exit improvement is backward-compatible and release-worthy as a patch after 1.5.0. Release Please determines and publishes the resulting 1.5.x version after the qualifying `fix:` commit reaches `main` and the release pull request is reviewed and merged.
