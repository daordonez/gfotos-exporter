# Troubleshooting

## ExifTool is missing

Install it with `brew install exiftool`, then rerun `gfotos-migrator doctor`.

## The selected volume is rejected

The migration requires external APFS storage. The selected path may be internal, formatted as a non-APFS filesystem, mounted read-only, or have insufficient free capacity.

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
