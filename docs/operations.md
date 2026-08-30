# Operations Guide

## Prepare storage

Use a dedicated external disk. Do not use a Time Machine destination. Guided migration inventories the Takeout first, then automatically discovers and lists available external volumes for selection. The list shows each volume's name, filesystem, available space, and total capacity. System volumes, Time Machine destinations, and read-only volumes are excluded. APFS volumes with sufficient free space are used immediately without formatting. A non-APFS volume, or an APFS volume without enough space, requires erasing its entire external physical disk and converting it to APFS; the exact disk identifier must be typed before any change. The default descriptive APFS volume name is `GPhotos_Export`, which can be changed before formatting. If no selectable volume is connected, guided migration offers the option to format an external disk or cancel the migration.

Keep the isolated Photos library, the migration database, reports, and temporary extraction directory on this volume. The tool requires enough free space for the uncompressed Takeout media plus 20 percent headroom.

The `prepare-volume` command remains available as an advanced option for scripted workflows that need to format a disk outside the guided migration flow.

## Create the isolated library

1. Quit Photos.
2. Hold Option while opening Photos.
3. Select **Create New**.
4. Save the library as `GoogleTakeoutMigration.photoslibrary` in the selected external volume.
5. Do not select **Use as System Photo Library**.
6. Do not enable iCloud Photos in this library.

The guided migration waits for this library before it starts importing.

## Permissions

Guided migration checks ExifTool and offers to install it through Homebrew when it is missing. The first Photos import triggers a macOS Automation permission request for the terminal application. Approve it only after verifying the isolated library is open. If macOS blocks protected-library inspection, grant Full Disk Access to the terminal application in Privacy & Security and rerun `doctor`.

## Updates

Each guided migration launch checks GitHub Releases for a newer stable package before showing the main menu. The check has a short timeout and failures do not block migration. When an update is available, the operator can accept it to download the exact matching release package and install it with `npm` globally using the prefix that owns the resolved executable, then restart the command. Rejecting the prompt makes no change.

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

Run `status` to inspect imported, failed, skipped, and unknown items. Failed items remain in SQLite with their error. Unknown items are intentionally not re-imported automatically because Photos may have accepted them before a process interruption.

Run `report` to write a Markdown result summary under `.gfotos-migrator/reports` on the external volume.

## Handoff

Run `handoff-check` before touching the main library. It blocks when the volume containing the main library lacks enough currently free storage for the isolated library size. iCloud optimization is not treated as available immediate capacity.

Open the main library manually, choose **File > Import**, select the isolated Photos library, review the presented items, and choose **Import All New Items** only after verification. Do not delete the isolated library until the main library and iCloud have been checked.
