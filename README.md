# gfotos-migrator

A local tool that prepares a Google Photos Takeout export as an **Import Bundle**: a flat `import/` directory of deduplicated original photos and videos, plus their Google Takeout sidecar metadata, on any writable destination volume with enough free capacity. It never modifies Takeout inputs, does not require macOS, Photos, iCloud, or an APFS-formatted volume, and never automates an import into Photos. After preparation you manually open Photos (or another tool of your choice) and import the files under the reported `import/` path.

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

Non-interactive commands back the same guided workflow and are suitable for scripting:

```sh
gfotos-migrator inspect --source <takeout-folder> [--volume <destination-volume>]
gfotos-migrator prepare --source <takeout-folder> --volume <destination-volume>
gfotos-migrator resume --source <takeout-folder> --volume <destination-volume>
gfotos-migrator status --volume <destination-volume>
gfotos-migrator report --volume <destination-volume>
```

`inspect` reports the Takeout inventory and, when `--volume` is given, validates that the destination is writable and has enough free capacity. `prepare` and `resume` both call the same resumable bundle engine. `status` prints the current bundle manifest, and `report` writes a Markdown summary under `.gfotos-migrator/reports` on the destination volume.

Outside the guided workflow, a "Tools" menu offers the same actions (Inspect Takeout, Prepare or resume Import Bundle, Status, Report) interactively.

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

## AI-assisted development

Repository-specific GitHub Copilot cloud agent profiles, validation boundaries,
and the required repository settings are documented in
[the AI agent workflow](docs/ai-agent-workflow.md).

## Continuous integration and releases

Every pull request and every push to `main` runs the type check, test suite, and local package build on GitHub Actions. The resulting `.tgz` is retained as a workflow artifact for seven days.

Releases use [Conventional Commits](https://www.conventionalcommits.org/). After a qualifying commit reaches `main`, Release Please opens or updates a release pull request. Merging that pull request updates the version, creates an incremental `vX.Y.Z` tag and GitHub Release, then attaches the matching `gfotos-migrator-X.Y.Z.tgz` package.

Use `fix:` for patch releases, `feat:` for minor releases, and `feat!:` or a `BREAKING CHANGE:` footer for major releases. Use other commit types such as `docs:` or `chore:` when a release is not required.
