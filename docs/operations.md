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

Each guided migration launch checks GitHub Releases for a newer stable package before showing the main menu. The check has a short timeout and failures do not block migration. When an update is available, the operator can accept it to download the exact matching release package and install it with `npm` globally, then restart the command. Rejecting the prompt makes no change.

Published releases are public. The update check and package download do not require a GitHub account, GitHub CLI, or a token.

## Recovery

Run `status` to inspect imported, failed, skipped, and unknown items. Failed items remain in SQLite with their error. Unknown items are intentionally not re-imported automatically because Photos may have accepted them before a process interruption.

Run `report` to write a Markdown result summary under `.gfotos-migrator/reports` on the external volume.

## Handoff

Run `handoff-check` before touching the main library. It blocks when the volume containing the main library lacks enough currently free storage for the isolated library size. iCloud optimization is not treated as available immediate capacity.

Open the main library manually, choose **File > Import**, select the isolated Photos library, review the presented items, and choose **Import All New Items** only after verification. Do not delete the isolated library until the main library and iCloud have been checked.
