# gfotos-migrator

A local tool that prepares a Google Photos Takeout export as an **Import Bundle** on any writable destination volume with enough free capacity. Each bundle has exactly two top-level outputs: a flat `import/` directory of deduplicated original photos and videos, plus a hidden `.gfotos-migrator/` state directory containing the manifest, SQLite provenance, extracted sidecar metadata, and reports. It never modifies Takeout inputs, does not require macOS, Photos, iCloud, or an APFS-formatted volume, and never automates an import into Photos. After preparation you manually open Photos (or another tool of your choice) and import the files under the reported `import/` path.

## Installation

The installer prepares Node.js and npm, displays the three latest published releases, and makes `gfotos-migrator` available to the current user. Pressing Enter selects the latest release.

1. Clone the repository:

```sh
git clone https://github.com/daordonez/gfotos-exporter.git
cd gfotos-exporter
chmod +x install-gfotos-migrator.sh
./install-gfotos-migrator.sh
```

2. Open a new terminal if needed and verify the installation:

```sh
gfotos-migrator --help
```

The installer supports macOS and Linux for dependency installation. Bundle preparation itself works on any platform Node.js supports and only requires a writable destination path with enough free space; it does not require Photos, iCloud, or an external disk.

## Usage

Start the guided workflow:

```sh
gfotos-migrator guided-migration
```

When guided migration starts, the tool checks published GitHub Releases and offers to install a newer stable version. The update installs into the same npm prefix that owns the resolved executable and verifies the installed version before prompting a restart. Rejecting the prompt continues without changes. No GitHub account or token is required.

To upgrade from version `0.0.0` or any release that predates the in-app updater, rerun the installer:

```sh
./install-gfotos-migrator.sh
```

See the [upgrade compatibility matrix](docs/operations.md#upgrade-compatibility-matrix) for the full version table and repair steps.

Google Takeout ZIP archives are treated as read-only input and are never modified. The guided workflow inventories the Takeout source, lets you select a writable destination volume with enough free space, and prepares the Import Bundle: a flat `import/` directory containing deduplicated original files plus a `.gfotos-migrator/` state directory (manifest, SQLite state, extracted sidecar metadata, and reports). The bundle is resumable: rerunning preparation with the same source and destination continues from where it left off instead of redoing completed work.

After preparation completes, open Photos (or your preferred tool) and manually import the files under the reported `import/` path. `gfotos-migrator` does not automate Photos import, does not request Automation permission, and does not touch iCloud settings.

### Bundle layout and metadata

- `import/` contains only the final photo and video files to import manually.
- `.gfotos-migrator/manifest.json` records bundle counts and source compatibility.
- `.gfotos-migrator/bundle.sqlite` preserves SHA-256 deduplication, per-item state, and provenance back to the original archive entry.
- `.gfotos-migrator/sidecars/` stores verbatim extracted Google Takeout sidecar JSON keyed by the canonical file hash.
- `.gfotos-migrator/reports/` stores generated Markdown reports.

Before an extracted photo or video is ever reported as ready for import, `gfotos-migrator` validates it by content (parsing JPEG/PNG/MP4 structure, not just trusting the file extension). A structurally invalid source is recorded as `failed` with a diagnostic instead of being placed in `import/`; the original Takeout archive is never touched.

When sidecar metadata is present, `gfotos-migrator` preserves a normalized metadata record in `.gfotos-migrator/` and attempts to embed supported fields into the output media via ExifTool. This embedding is transactional: ExifTool writes to a temporary copy, which is validated by content before atomically replacing the real output file. If the enriched copy fails validation, the original unmodified file is kept as the output and the metadata fields are reported as `unsupported` rather than `applied`. The report distinguishes fields that were applied to the output file, preserved only in bundle state, missing from the sidecar, invalid, or conflicting across duplicate inputs. A future native macOS client should consume importable media from `import/` and provenance or metadata from `.gfotos-migrator/`.

After you drag files from `import/` into Photos, this tool cannot guarantee how Photos will display, retain, or normalize that metadata. Use the bundle report as the source of truth for what the Takeout sidecars contained and what the CLI verified before the manual import step.

Non-interactive commands back the same guided workflow and are suitable for scripting:

```sh
gfotos-migrator inspect --source <takeout-folder> [--volume <destination-volume>]
gfotos-migrator prepare --source <takeout-folder> --volume <destination-volume>
gfotos-migrator resume --source <takeout-folder> --volume <destination-volume>
gfotos-migrator status --volume <destination-volume>
gfotos-migrator report --volume <destination-volume>
```

`inspect` reports the Takeout inventory and, when `--volume` is given, validates that the destination is writable and has enough free capacity. `prepare` and `resume` both call the same resumable bundle engine. `status` prints the current bundle manifest, and `report` writes a Markdown summary under `.gfotos-migrator/reports` on the destination volume.

Outside the guided workflow, a "Tools" menu offers the same actions (Inspect Takeout, Prepare or resume Import Bundle, Status, Report) plus **Analyze and repair existing Import Bundle**. The repair workflow uses only the existing `import/` and `.gfotos-migrator/` state, creates an analysis report first, and requires explicit confirmation before changing SQLite or manifest state. It can backfill verified `finalHash` values and transactionally reapply normalized metadata already stored in the bundle; it never deletes, renames, or re-encodes media. Missing or corrupt media is reported as requiring the original Takeout source. Select "Exit" from the main menu to close the TUI cleanly without using a keyboard interrupt.

The [MVP checkpoint](docs/mvp-checkpoint.md) records the product capabilities, safety boundaries, and validation evidence established by the 1.5.x release line.

## Development

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm pack:local
```

## AI-assisted development

Repository-specific GitHub Copilot cloud agent profiles, validation boundaries,
and the required repository settings are documented in
[the AI agent workflow](docs/ai-agent-workflow.md).

## Continuous integration and releases

Every pull request and every push to `main` runs `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, and `pnpm pack:local` on GitHub Actions. The resulting `.tgz` is retained as a workflow artifact for seven days.

Releases use [Conventional Commits](https://www.conventionalcommits.org/). After a qualifying commit reaches `main`, Release Please opens or updates a release pull request. Merging that pull request updates the version, creates a `gfotos-migrator-vX.Y.Z` tag and GitHub Release, then attaches the matching `gfotos-migrator-X.Y.Z.tgz` package.

Use `fix:` for patch releases, `feat:` for minor releases, and `feat!:` or a `BREAKING CHANGE:` footer for major releases. Use other commit types such as `docs:` or `chore:` when a release is not required.
