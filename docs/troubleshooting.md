# Troubleshooting

## Active command reports version 0.0.0 or is otherwise outdated

Version `0.0.0` predates the in-app updater and cannot offer an upgrade automatically. Rerun the installer to replace it with the latest stable release:

```sh
./install-gfotos-migrator.sh
```

If the installer is not available locally, clone the repository first:

```sh
git clone https://github.com/daordonez/gfotos-exporter.git
cd gfotos-exporter
chmod +x install-gfotos-migrator.sh
./install-gfotos-migrator.sh
```

After installation, open a new terminal and verify:

```sh
which -a gfotos-migrator
gfotos-migrator --version
```

## The selected volume is rejected

The selected path may be internal, mounted read-only, or have insufficient free capacity for the required migration space. Any writable filesystem is otherwise accepted; the Import Bundle does not require APFS or any formatting.

## No eligible external volume is listed

Connect a mounted external, writable volume and choose **Try again** from guided migration, or restart it. System volumes, configured Time Machine destinations, and read-only volumes are intentionally excluded.

## A video failed to prepare

Google Takeout can contain containers or codecs that fail to extract or verify. The `report` command preserves the failing archive entry and its error. Do not transcode originals in place; use a separate, documented conversion workflow if required.

## A ZIP is rejected

The importer rejects unsafe paths, archives with too many entries, and oversized entries. This is intentional protection against path traversal and ZIP bombs.

## Migration was interrupted

Run `status` and `report`. Materialized and duplicate items are skipped on a subsequent `prepare`/`resume` because the bundle database recognizes their SHA-256 hash. Failed items require inspection with `report` before a manual import.

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
