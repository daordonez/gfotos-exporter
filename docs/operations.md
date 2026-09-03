# Operations Guide

## Prepare storage

Choose any writable destination volume with enough free capacity — an external drive, a secondary internal volume, or a local directory. Guided migration inventories the Takeout source first, then discovers and lists available external volumes for selection when run interactively. The list shows each volume's name, filesystem, available space, and total capacity. System volumes, Time Machine destinations, and read-only volumes are excluded from the interactive list, but any writable filesystem is accepted — there is no APFS requirement and no disk formatting or erasure step. `inspect` and `prepare`/`resume` validate that the selected destination is writable and has enough free space (uncompressed Takeout media size plus 20 percent headroom) before writing anything.

## Import Bundle contract

The Import Bundle is written under the destination volume root and always has exactly two top-level outputs:

- `import/`: a flat directory containing only the final deduplicated photo and video files for manual import.
- `.gfotos-migrator/`: hidden bundle state containing `manifest.json`, `bundle.sqlite`, extracted sidecar JSON under `sidecars/`, and generated Markdown reports under `reports/`.

No other top-level entries are created by bundle preparation. If a future native macOS client consumes this bundle, it should read importable media from `import/` and provenance or metadata from `.gfotos-migrator/`.

## Metadata coverage

Google Takeout sidecar JSON is preserved under `.gfotos-migrator/sidecars/` and normalized into SQLite state so the bundle can report provenance, missing fields, invalid JSON, and conflicting values across duplicates. When supported by the output file format and local ExifTool installation, `gfotos-migrator` also verifies selected fields after embedding them into the copied media file.

Before an item is reported as `materialized`, its extracted bytes are validated by content (JPEG/PNG/MP4 structure is parsed; the file extension alone is never trusted). A structurally invalid extracted source is recorded as `failed` with a diagnostic message and is never written into `import/`; the original Takeout archive and the bytes extracted from it are left untouched. Metadata embedding via ExifTool is transactional: ExifTool writes into a temporary sibling copy, which is content-validated before atomically replacing the real output file. If the enriched copy fails validation, the previously valid output file is left in place, unmodified, and the affected metadata fields are reported as `unsupported` rather than `applied`.

The bundle report is the authoritative record of what was preserved before the manual import step:

- `applied`: a supported field was verified as embedded into the output media file.
- `present`: metadata was preserved in bundle state, but embedding was not attempted for that item.
- `unsupported`: the field was present in the Takeout metadata but could not be verified as embedded for that format or environment.
- `missing`: the sidecar was absent or the field was not present in the sidecar.
- `invalid`: the sidecar JSON could not be parsed.
- `conflicting`: duplicate media shared a hash but provided different sidecar values.

After you drag files from `import/` into Photos, `gfotos-migrator` cannot guarantee which metadata fields Photos will retain, normalize, or display. Treat `.gfotos-migrator/` and its report as the source of truth for preserved Takeout provenance and metadata.

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

`prepare`/`resume` are idempotent and resumable: rerunning them with the same Takeout source and destination volume skips items already materialized, duplicated, or skipped, and only retries items that previously failed or were never processed.

Use the following recovery rules:

- **Interrupted preparation:** rerun `prepare` or `resume` with the same `--source` and `--volume`. Completed items are recognized from bundle state and are not redone.
- **Missing bundle state:** if `status` or `report` says no bundle exists on the selected volume, point the command at a destination with a valid `.gfotos-migrator/manifest.json`, or run `prepare` first.
- **Corrupt bundle state:** if the manifest is missing required fields or cannot be parsed, do not edit Takeout inputs. To start fresh, use a new empty destination or manually clear both `import/` and `.gfotos-migrator/` from the existing destination before rerunning `prepare`.
- **Incompatible bundle state:** if the bundle was prepared from a different Takeout source, resume only with the original source. Otherwise use a new empty destination or clear both `import/` and `.gfotos-migrator/` before preparing a new bundle there.

Do not delete or rewrite files under `import/` unless you are intentionally discarding the entire generated bundle and starting over. Recovery never acts on the original Takeout ZIP archives.
