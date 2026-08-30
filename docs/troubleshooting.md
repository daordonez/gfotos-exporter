# Troubleshooting

## ExifTool is missing

Install it with `brew install exiftool`, then rerun `gfotos-migrator doctor`.

## The selected volume is rejected

The migration requires external APFS storage. The selected path may be internal, formatted as a non-APFS filesystem, mounted read-only, or have insufficient free capacity.

## No eligible external volume is listed

Connect a mounted external volume and restart guided migration. System volumes, configured Time Machine destinations, and read-only volumes are intentionally excluded. Non-APFS volumes can be selected, but converting one to APFS erases its entire external physical disk after exact identifier confirmation. Use the descriptive `GPhotos_Export` default name, or choose another clear migration-specific name, so the disk remains identifiable after formatting.

## Photos import is denied

Open System Settings, review Privacy & Security > Automation, and allow the terminal application to control Photos. Confirm that the isolated library, not the main library, is open before retrying.

## A video failed to import

Google Takeout can contain containers or codecs not supported by the installed version of Photos. The report preserves the failing archive entry. Do not transcode originals in place; use a separate, documented conversion workflow if required.

## A ZIP is rejected

The importer rejects unsafe paths, archives with too many entries, and oversized entries. This is intentional protection against path traversal and ZIP bombs.

## Migration was interrupted

Run `status` and `report`. Imported items are skipped on a subsequent import because the database recognizes their SHA-256 hash. Unknown items require manual review to avoid duplicates.

## Update check or installation fails

The update check is optional and does not affect migration. Confirm network access and that the selected GitHub Release includes the matching `gfotos-migrator-X.Y.Z.tgz` asset, then launch guided migration again.

## Installer reports a version mismatch after upgrade

The installer verifies both the installed package manifest and the active executable after every installation. A mismatch means a stale binary is shadowing the newly installed one.

**Remediation steps:**

1. The installer error message includes the actual prefix path used during installation (for example `~/.local`). Use that path in the commands below instead of `<prefix>`.

2. Identify the stale executable and the one installed by the installer:

   ```sh
   which -a gfotos-migrator
   gfotos-migrator --version
   ```

3. Remove the legacy global installation from the user prefix reported in the error message:

   ```sh
   npm uninstall --global gfotos-migrator --prefix <prefix>
   ```

4. If a stale binary still appears earlier on `PATH` (for example in `/usr/local/bin` or a Homebrew prefix), remove or rename it:

   ```sh
   rm "$(which gfotos-migrator)"
   ```

5. Open a new terminal to reload `PATH`, then verify the correct version is active:

   ```sh
   gfotos-migrator --version
   ```

6. If the correct version is not active, rerun the installer.
