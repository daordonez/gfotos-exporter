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

`prepare`/`resume`/`inspect --volume` require the destination path to exist, be a directory, be writable, and have enough free space (uncompressed Takeout media size plus 20 percent headroom). Any writable filesystem is accepted — there is no APFS requirement. Confirm the path is mounted and not read-only, and free up space or choose a larger destination if capacity is reported as insufficient.

## No eligible external volume is listed in guided migration

Connect a mounted, writable external volume and restart guided migration. System volumes, configured Time Machine destinations, and read-only volumes are intentionally excluded from the interactive list. You can also pass any writable directory path directly to `prepare`/`resume`/`inspect --volume` from the command line without using the interactive volume picker.

## A file failed to prepare

Preparation extracts and hashes each Takeout entry independently, so a single unreadable or unsupported entry does not stop the rest of the bundle. `report` preserves the failing archive entry and error message. Do not transcode or otherwise modify originals in the Takeout source; investigate the specific archive entry separately if required.

## The bundle is missing on the selected destination

`status` and `report` require an existing Import Bundle. If a command reports `No bundle found at the specified volume. Run \`prepare\` first.`, confirm that you pointed `--volume` at the destination root that contains both `import/` and `.gfotos-migrator/`. If the destination has never been prepared, run `prepare` first.

## A ZIP is rejected

The bundle engine rejects unsafe paths, archives with too many entries, and oversized entries. This is intentional protection against path traversal and ZIP bombs.

## Preparation was interrupted

Run `status` and `report` against the destination volume. `prepare`/`resume` are idempotent: items already materialized, duplicated, or skipped are recognized by their SHA-256 hash and are not reprocessed. Only pending and previously failed items are retried on the next run.

## Missing sidecar metadata is reported

The bundle status includes a `missingSidecar` count. A non-zero value means one or more materialized media files had no matching Takeout sidecar JSON. The media file can still be materialized into `import/`, but the missing metadata is preserved as a reportable state in `.gfotos-migrator/` rather than guessed or synthesized.

## Bundle state is corrupt or incompatible

If `prepare` or `resume` reports that bundle state is corrupt or was prepared for a different source, do not edit the Takeout ZIP archives and do not delete imported media to force recovery.

- If the bundle was created from the same Takeout source and only the state is corrupt, remove `.gfotos-migrator/` from the destination and run `prepare` again.
- If the bundle belongs to a different Takeout source, rerun `prepare` or `resume` with the original source path instead.

Recovery actions apply only to the destination bundle state. The Takeout source remains read-only.

## Update check or installation fails

The update check is optional and does not affect bundle preparation. Confirm network access and that the selected GitHub Release includes the matching `gfotos-migrator-X.Y.Z.tgz` asset, then launch guided migration again.

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
