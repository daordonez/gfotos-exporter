# gfotos-migrator

A local macOS tool that imports Google Photos Takeout ZIP archives into an isolated Photos library on an external APFS volume. It does not modify the main Photos library during migration.

## Installation

The installer prepares Node.js, npm, and ExifTool, displays the three latest published releases, and makes `gfotos-migrator` available to the current user. Pressing Enter selects the latest release.

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

The installer supports macOS and Linux for dependency installation. Migration itself requires macOS, Photos, and an external APFS volume.

## Usage

Start the guided workflow:

```sh
gfotos-migrator guided-migration
```

When guided migration starts, the tool checks published GitHub Releases and offers to install a newer stable version. Rejecting the prompt continues migration without changes. No GitHub account or token is required.

The target library is `GoogleTakeoutMigration.photoslibrary`. It must remain outside iCloud Photos and cannot be the System Photo Library. Takeout ZIP archives are treated as read-only input.

When selecting a destination, guided migration lists mounted external volumes and shows their filesystem and free capacity. It excludes system volumes, Time Machine destinations, and read-only volumes. A non-APFS volume, or an APFS volume without enough space, can be erased and converted to APFS only after exact whole-disk confirmation. The default descriptive volume name is `GPhotos_Export` and can be changed before formatting. If no selectable volume is connected, guided migration ends without changing any disk.

To erase and prepare an external disk, use `prepare-volume` only after confirming its identifier in Disk Utility or with `diskutil list`: this operation deletes all contents of the selected disk.

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

## Continuous integration and releases

Every pull request and every push to `main` runs the type check, test suite, and local package build on GitHub Actions. The resulting `.tgz` is retained as a workflow artifact for seven days.

Releases use [Conventional Commits](https://www.conventionalcommits.org/). After a qualifying commit reaches `main`, Release Please opens or updates a release pull request. Merging that pull request updates the version, creates an incremental `vX.Y.Z` tag and GitHub Release, then attaches the matching `gfotos-migrator-X.Y.Z.tgz` package.

Use `fix:` for patch releases, `feat:` for minor releases, and `feat!:` or a `BREAKING CHANGE:` footer for major releases. Use other commit types such as `docs:` or `chore:` when a release is not required.
