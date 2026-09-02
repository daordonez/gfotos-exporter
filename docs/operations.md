# Operations Guide

## Prepare storage

Choose any writable destination volume with enough free capacity — an external drive, a secondary internal volume, or a local directory. Guided migration inventories the Takeout source first, then discovers and lists available external volumes for selection when run interactively. The list shows each volume's name, filesystem, available space, and total capacity. System volumes, Time Machine destinations, and read-only volumes are excluded from the interactive list, but any writable filesystem is accepted — there is no APFS requirement and no disk formatting or erasure step. `inspect` and `prepare`/`resume` validate that the selected destination is writable and has enough free space (uncompressed Takeout media size plus 20 percent headroom) before writing anything.

The Import Bundle is written under the destination volume root: a flat `import/` directory containing deduplicated original photos and videos, and a `.gfotos-migrator/` directory holding the manifest, SQLite state, extracted sidecar metadata, and reports. No other top-level entries are created.

## Manual Photos import

`gfotos-migrator` does not automate importing files into Photos and does not request macOS Automation permission. After `prepare`/`resume` completes (or the guided workflow reaches its completion screen), open Photos manually, choose **File > Import**, and select the files under the reported `import/` path. Review the import before completing it. The tool never modifies the main Photos library or enables iCloud Photos automatically because it never touches Photos at all.

## Updates

Each guided migration launch checks GitHub Releases for a newer stable package before showing the main menu. The check has a short timeout and failures do not block bundle preparation. When an update is available, the operator can accept it to download the exact matching release package and install it with `npm` globally using the prefix that owns the resolved executable, then restart the command. Rejecting the prompt makes no change.

Published releases are public. The update check and package download do not require a GitHub account, GitHub CLI, or a token.

After installation the update is verified: the newly installed package manifest is read to confirm the version, and the active executable is run with `--version` to confirm that no stale binary is shadowing the new one. If either check fails, the installation is reported as failed and the tool continues without updating.

## Upgrade compatibility matrix

| Installed version | In-app updater | Supported upgrade route |
| --- | --- | --- |
| `0.0.0` | No — predates the updater | Re-run `./install-gfotos-migrator.sh` |
| `0.1.x` | Yes | Offered automatically at guided-migration launch |
| `1.x` (current) | Yes — with prefix detection and post-install verification | Offered automatically at guided-migration launch |

To verify the active installation:

```sh
which -a gfotos-migrator
gfotos-migrator --version
```

### Repair a stale or legacy installation

If `gfotos-migrator --version` reports `0.0.0` or any version that predates the current release, rerun the installer:

```sh
./install-gfotos-migrator.sh
```

The installer selects the latest published release, removes any previous installation from the managed prefix (`~/.local`), installs the new package, and verifies both the package manifest and the active executable before completing.

## Recovery

Run `status --volume <destination-volume>` to inspect the bundle manifest: total, materialized, duplicate, failed, skipped, pending, and missing-sidecar counts. Run `report --volume <destination-volume>` to write a Markdown result summary under `.gfotos-migrator/reports` on the destination volume, including per-item state and error detail.

`prepare`/`resume` are idempotent and resumable: rerunning them with the same Takeout source and destination volume skips items already materialized, duplicated, or skipped, and only retries items that previously failed or were never processed. If the manifest is corrupt or was created for a different Takeout source, `prepare`/`resume` fail with guidance to either use the original source to resume or remove `.gfotos-migrator/` on the volume to start fresh.
