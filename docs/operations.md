# Operations Guide

## Prepare storage

Guided migration inventories the Takeout source first, then automatically discovers and lists selectable external volumes for the Import Bundle destination. The list shows each volume's name, filesystem, available space, and total capacity. System volumes, Time Machine destinations, and read-only volumes are excluded. Any writable filesystem with enough free space works — the Import Bundle does not require APFS and never formats or erases a disk. The tool requires enough free space for the uncompressed Takeout media plus 20 percent headroom. If no selectable volume is connected, guided migration offers to try discovery again or cancel.

Keep the Import Bundle (`import/` and `.gfotos-migrator/`) on this volume until it has been reviewed and imported into Photos.

## Tools

Run `gfotos-migrator` with no arguments to see the root menu (`Start guided migration`, `Tools`). The Tools submenu exposes the same operations as non-interactive commands, for operators and automation:

| Tool / Command | Purpose |
| --- | --- |
| `inspect --source <takeout-folder> [--volume <volume>]` | Report the Takeout inventory, required free space, and (when `--volume` is given) whether the destination has enough room. |
| `prepare` / `resume --source <takeout-folder> --volume <volume>` | Materialize the Import Bundle under `<volume>/import`, deduplicating by SHA-256. Safe to rerun; already materialized items are skipped. |
| `status --volume <volume>` | Print bundle counts by state (materialized, duplicate, failed, skipped, pending). |
| `report --volume <volume>` | Write a Markdown summary under `<volume>/.gfotos-migrator/reports`. |

## Updates

Each guided migration launch checks GitHub Releases for a newer stable package before showing the root menu. The check has a short timeout and failures do not block migration. When an update is available, the operator can accept it to download the exact matching release package and install it with `npm` globally using the prefix that owns the resolved executable, then restart the command. Rejecting the prompt makes no change.

Published releases are public. The update check and package download do not require a GitHub account, GitHub CLI, or a token.

After installation the update is verified: the newly installed package manifest is read to confirm the version, and the active executable is run with `--version` to confirm that no stale binary is shadowing the new one. If either check fails, the installation is reported as failed and migration continues without updating.

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

Run `status` to inspect materialized, duplicate, failed, skipped, and pending items. Failed items remain in the bundle database with their error. Rerunning `prepare`/`resume` is safe: already materialized or duplicate items are recognized by their SHA-256 hash and are not reprocessed.

Run `report` to write a Markdown result summary under `.gfotos-migrator/reports` on the destination volume.

## Manual import into Photos

Guided migration and `prepare`/`resume` never open Photos or request Automation permission. Once the Import Bundle is ready, the only remaining step is manual: open Photos, choose **File > Import**, select the `import/` folder on the destination volume, and review the presented items before importing. Do not delete the Import Bundle until the import has been verified.
