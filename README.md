# gfotos-migrator

A local macOS tool that prepares Google Photos Takeout ZIP archives into a portable Import Bundle (`import/`) on any writable external volume, ready for a manual import into Photos. It never opens Photos, never requests Automation permission, and never modifies the main Photos library.

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

The installer supports macOS and Linux for dependency installation. External volume discovery relies on macOS tools (`diskutil`, `df`), so guided migration requires macOS.

## Usage

Run `gfotos-migrator` with no arguments (or `gfotos-migrator guided-migration`) to open the root menu with two choices: **Start guided migration** and **Tools**.

```sh
gfotos-migrator guided-migration
```

When guided migration starts, the tool checks published GitHub Releases and offers to install a newer stable version. The update installs into the same npm prefix that owns the resolved executable and verifies the installed version before prompting a restart. Rejecting the prompt continues migration without changes. No GitHub account or token is required.

To upgrade from version `0.0.0` or any release that predates the in-app updater, rerun the installer:

```sh
./install-gfotos-migrator.sh
```

See the [upgrade compatibility matrix](docs/operations.md#upgrade-compatibility-matrix) for the full version table and repair steps.

Takeout ZIP archives are treated as read-only input. After selecting a source folder, guided migration automatically discovers and lists selectable external volumes for the Import Bundle destination — its name, filesystem, available space, and total capacity. System volumes, Time Machine destinations, and read-only volumes are excluded. Any writable filesystem with enough free space is accepted; no APFS conversion or disk formatting is performed. Guided migration then materializes the bundle under `<volume>/import`, deduplicating by SHA-256, and reports the `import/` folder, verification status, summary counts, and the single remaining manual step: opening Photos, choosing **File > Import**, and selecting the `import/` folder.

The **Tools** submenu exposes the same operations as non-interactive commands for operators and automation: `inspect`, `prepare`/`resume`, `status`, and `report`. See [the operations guide](docs/operations.md#tools) for details.

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
