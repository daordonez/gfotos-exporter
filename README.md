# gfotos-migrator

`gfotos-migrator` is a local macOS terminal application that imports Google Photos Takeout ZIP archives into an isolated Photos library on external APFS storage. It supports supported photos and videos, restores Google Takeout capture dates when metadata is available, prevents repeat imports with a local SQLite database, and never changes the main Photos library during migration.

## Safety model

- The migration destination is always `GoogleTakeoutMigration.photoslibrary` on external APFS storage.
- The destination library must not be the System Photo Library and must not have iCloud Photos enabled.
- Original ZIP archives are read-only inputs. Only temporary extracted copies are deleted after a confirmed import.
- The only destructive command is `prepare-volume`. It requires the selected whole disk identifier twice.
- An interrupted item is not automatically imported again when its Photos result is uncertain.

## Requirements

- macOS with Photos.
- Node.js 22.13 or newer.
- Homebrew.
- ExifTool: `brew install exiftool`.
- An external APFS volume. USB flash drives are allowed with a warning, but an external SSD is strongly recommended.
- Terminal access to Photos automation when macOS asks for permission. Full Disk Access may be required to inspect a protected Photos library.

## Install from a local package

Build the distributable package on the development Mac:

```sh
pnpm install --frozen-lockfile
pnpm pack:local
```

Install the generated package on the target Mac:

```sh
npm install --global ./gfotos-migrator-0.1.0.tgz
gfotos-migrator --help
```

Uninstall it with:

```sh
npm uninstall --global gfotos-migrator
```

## Guided migration

Run:

```sh
gfotos-migrator guided-migration
```

The terminal UI asks for the Takeout directory and external APFS volume, checks space and dependencies, then guides you through creating `GoogleTakeoutMigration.photoslibrary` with the native Photos library chooser. Keep that library outside iCloud Photos. The app opens it before importing.

After reviewing the isolated library, open your main Photos library and choose **File > Import**. Select the isolated library and review the items before choosing **Import All New Items**. Run `handoff-check` first to verify that the main-library volume has enough free space.

## Advanced commands

```sh
gfotos-migrator doctor --source /path/to/takeout --volume /Volumes/GoogleMigration
gfotos-migrator import-takeout --source /path/to/takeout --volume /Volumes/GoogleMigration
gfotos-migrator resume --source /path/to/takeout --volume /Volumes/GoogleMigration
gfotos-migrator status --volume /Volumes/GoogleMigration
gfotos-migrator report --volume /Volumes/GoogleMigration
gfotos-migrator handoff-check --volume /Volumes/GoogleMigration --main-library "$HOME/Pictures/Photos Library.photoslibrary"
gfotos-migrator cleanup --volume /Volumes/GoogleMigration --confirm-library GoogleTakeoutMigration.photoslibrary
```

To erase and prepare an external disk, first inspect the disk identifier with Disk Utility or `diskutil list`, then run:

```sh
gfotos-migrator prepare-volume --disk disk4 --name GoogleMigration --confirm disk4
```

This permanently erases every volume on `disk4`.

## Development

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

Project-authored documentation, CLI messages, logs, and code are intentionally written in English.
