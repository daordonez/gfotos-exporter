# Operations Guide

## Prepare storage

Use a dedicated external disk. Do not use a Time Machine destination. Guided migration inventories the Takeout first, then offers to use an existing external APFS volume or to erase an external physical disk and create a new APFS volume. Keep the isolated Photos library, the migration database, reports, and temporary extraction directory on this volume. The tool requires enough free space for the uncompressed Takeout media plus 20 percent headroom.

The guided preparation path lists eligible external physical disks, shows their identifiers, names, and capacities, and requires the selected identifier to be typed exactly before erasing it. It validates the new APFS volume and its free space after formatting. `prepare-volume` remains available as the equivalent advanced command for scripted workflows.

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

For a private repository, provide a fine-grained token with `Contents: Read` through `GITHUB_TOKEN` or `GH_TOKEN` for that terminal session, or authenticate GitHub CLI with `gh auth login`. The tool does not persist or print the token.

## Recovery

Run `status` to inspect imported, failed, skipped, and unknown items. Failed items remain in SQLite with their error. Unknown items are intentionally not re-imported automatically because Photos may have accepted them before a process interruption.

Run `report` to write a Markdown result summary under `.gfotos-migrator/reports` on the external volume.

## Handoff

Run `handoff-check` before touching the main library. It blocks when the volume containing the main library lacks enough currently free storage for the isolated library size. iCloud optimization is not treated as available immediate capacity.

Open the main library manually, choose **File > Import**, select the isolated Photos library, review the presented items, and choose **Import All New Items** only after verification. Do not delete the isolated library until the main library and iCloud have been checked.
