#!/usr/bin/env node
import {readdir, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {MigrationDatabase} from './database.js';
import {exifToolAvailable} from './media.js';
import {importCandidates, initializePaths, requiredBytes} from './migration.js';
import {isPhotosRunning, openPhotosLibrary} from './photos.js';
import {inventoryTakeout} from './takeout.js';
import {eraseExternalDisk, inspectVolume, validateExternalApfs} from './volume.js';
import {runTui} from './tui.js';
import {VERSION} from './version.js';
import {prepareBundle, getBundleStatus, writeBundleReport} from './bundle.js';

function option(argumentsList: string[], name: string): string | undefined {
  const index = argumentsList.indexOf(name);
  return index >= 0 ? argumentsList[index + 1] : undefined;
}

function requiredOption(argumentsList: string[], name: string): string {
  const value = option(argumentsList, name);
  if (!value || value.startsWith('--')) throw new Error(`Missing required option: ${name}`);
  return value;
}

function printHelp(): void {
  console.log(`gfotos-migrator ${VERSION}

Usage:
  gfotos-migrator guided-migration
  gfotos-migrator doctor --source <takeout-folder> --volume <external-volume>
  gfotos-migrator import-takeout --source <takeout-folder> --volume <external-volume>
  gfotos-migrator resume --source <takeout-folder> --volume <external-volume>
  gfotos-migrator status --volume <external-volume>
  gfotos-migrator report --volume <external-volume>
  gfotos-migrator bundle-prepare --source <takeout-folder> --volume <volume>
  gfotos-migrator bundle-resume --source <takeout-folder> --volume <volume>
  gfotos-migrator bundle-status --volume <volume>
  gfotos-migrator bundle-report --volume <volume>
  gfotos-migrator handoff-check --volume <external-volume> --main-library <photoslibrary>
  gfotos-migrator cleanup --volume <external-volume> --confirm-library GoogleTakeoutMigration.photoslibrary
  gfotos-migrator prepare-volume --disk <diskN> --name <volume-name> --confirm <diskN>

Safety:
  prepare-volume permanently erases the selected external whole disk.
  import-takeout imports only into GoogleTakeoutMigration.photoslibrary on the selected volume.
  bundle-prepare/bundle-resume work on any writable volume without APFS or formatting requirements.
`);
}

async function directoryBytes(target: string): Promise<number> {
  const entries = await readdir(target, {withFileTypes: true});
  let total = 0;
  for (const entry of entries) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

async function doctor(argumentsList: string[]): Promise<void> {
  const source = requiredOption(argumentsList, '--source');
  const volume = requiredOption(argumentsList, '--volume');
  const {inventory} = await inventoryTakeout(source);
  const volumeInfo = await validateExternalApfs(volume, requiredBytes(inventory));
  const exifTool = await exifToolAvailable();
  console.log(JSON.stringify({
    ok: exifTool && inventory.archives > 0,
    source: path.resolve(source),
    inventory,
    requiredBytes: requiredBytes(inventory),
    volume: volumeInfo,
    exifTool,
    nextStep: 'Create GoogleTakeoutMigration.photoslibrary on the selected volume, keep it outside iCloud Photos, then run import-takeout.'
  }, null, 2));
  if (!exifTool) process.exitCode = 2;
}

async function importTakeout(argumentsList: string[]): Promise<void> {
  const source = requiredOption(argumentsList, '--source');
  const volume = requiredOption(argumentsList, '--volume');
  const {inventory, media} = await inventoryTakeout(source);
  await validateExternalApfs(volume, requiredBytes(inventory));
  if (!await exifToolAvailable()) throw new Error('ExifTool is required. Install it with: brew install exiftool');
  const paths = await initializePaths(path.resolve(volume));
  try {
    await stat(paths.libraryPath);
  } catch {
    throw new Error(`The isolated library does not exist: ${paths.libraryPath}`);
  }
  await openPhotosLibrary(paths.libraryPath);
  const result = await importCandidates(paths, media, progress => {
    process.stdout.write(`\r${progress.completed}/${progress.total} processed | ${progress.imported} imported | ${progress.skipped} skipped | ${progress.failed} failed`);
  });
  process.stdout.write('\n');
  console.log(JSON.stringify(result, null, 2));
}

async function migrationStatus(volume: string): Promise<void> {
  const paths = await initializePaths(path.resolve(volume));
  const database = await MigrationDatabase.open(paths.databasePath);
  try {
    console.log(JSON.stringify(database.countByStatus(), null, 2));
  } finally { database.close(); }
}

async function writeReport(volume: string): Promise<void> {
  const paths = await initializePaths(path.resolve(volume));
  const database = await MigrationDatabase.open(paths.databasePath);
  try {
    const counts = database.countByStatus();
    const items = database.listItems();
    const report = `# Google Takeout Migration Report\n\nGenerated: ${new Date().toISOString()}\n\n| Status | Count |\n| --- | ---: |\n${Object.entries(counts).map(([status, count]) => `| ${status} | ${count} |`).join('\n')}\n\n## Items\n\n| Status | Type | Archive entry | Error |\n| --- | --- | --- | --- |\n${items.map(item => `| ${item.status} | ${item.mediaKind} | ${item.entryPath.replaceAll('|', '\\|')} | ${(item.error ?? '').replaceAll('|', '\\|')} |`).join('\n')}\n`;
    const destination = path.join(paths.reportPath, `migration-${new Date().toISOString().replaceAll(':', '-')}.md`);
    await writeFile(destination, report, {mode: 0o600});
    console.log(destination);
  } finally { database.close(); }
}

async function handoffCheck(argumentsList: string[]): Promise<void> {
  const volume = requiredOption(argumentsList, '--volume');
  const mainLibrary = requiredOption(argumentsList, '--main-library');
  const paths = await initializePaths(path.resolve(volume));
  const stagingBytes = await directoryBytes(paths.libraryPath);
  const mainVolume = await inspectVolume(mainLibrary);
  if (mainVolume.availableBytes < stagingBytes) throw new Error('The main library volume does not have enough available space for the isolated library contents.');
  console.log(`Handoff is safe to review. Open the main library in Photos, choose File > Import, select ${paths.libraryPath}, and review the import before choosing Import All New Items.`);
}

async function prepareVolume(argumentsList: string[]): Promise<void> {
  const disk = requiredOption(argumentsList, '--disk');
  const name = requiredOption(argumentsList, '--name');
  const confirmation = requiredOption(argumentsList, '--confirm');
  if (confirmation !== disk) throw new Error('Confirmation must exactly match the selected disk identifier.');
  await eraseExternalDisk(disk, name);
  console.log(`External disk ${disk} was erased and formatted as APFS volume ${name}.`);
}

async function cleanup(argumentsList: string[]): Promise<void> {
  const volume = requiredOption(argumentsList, '--volume');
  const confirmation = requiredOption(argumentsList, '--confirm-library');
  if (confirmation !== 'GoogleTakeoutMigration.photoslibrary') throw new Error('Confirmation must exactly match GoogleTakeoutMigration.photoslibrary.');
  const paths = await initializePaths(path.resolve(volume));
  await rm(paths.libraryPath, {recursive: true, force: false});
  console.log(`Removed isolated library: ${paths.libraryPath}`);
}

async function bundlePrepare(argumentsList: string[]): Promise<void> {
  const source = requiredOption(argumentsList, '--source');
  const volume = requiredOption(argumentsList, '--volume');
  const result = await prepareBundle(path.resolve(volume), source, progress => {
    process.stdout.write(`\r${progress.completed}/${progress.total} processed | ${progress.materialized} materialized | ${progress.duplicate} duplicate | ${progress.failed} failed`);
  });
  process.stdout.write('\n');
  console.log(JSON.stringify(result, null, 2));
}

async function bundleStatus(argumentsList: string[]): Promise<void> {
  const volume = requiredOption(argumentsList, '--volume');
  const manifest = await getBundleStatus(path.resolve(volume));
  console.log(JSON.stringify(manifest, null, 2));
}

async function bundleReport(argumentsList: string[]): Promise<void> {
  const volume = requiredOption(argumentsList, '--volume');
  const reportPath = await writeBundleReport(path.resolve(volume));
  console.log(reportPath);
}

async function main(): Promise<void> {
  const [command = 'guided-migration', ...argumentsList] = process.argv.slice(2);
  if (command === '--help' || command === '-h' || command === 'help') return printHelp();
  if (command === '--version' || command === '-v') return console.log(VERSION);
  if (command === 'guided-migration') return runTui();
  if (command === 'doctor') return doctor(argumentsList);
  if (command === 'import-takeout' || command === 'resume') return importTakeout(argumentsList);
  if (command === 'status') return migrationStatus(requiredOption(argumentsList, '--volume'));
  if (command === 'report') return writeReport(requiredOption(argumentsList, '--volume'));
  if (command === 'bundle-prepare' || command === 'bundle-resume') return bundlePrepare(argumentsList);
  if (command === 'bundle-status') return bundleStatus(argumentsList);
  if (command === 'bundle-report') return bundleReport(argumentsList);
  if (command === 'handoff-check') return handoffCheck(argumentsList);
  if (command === 'prepare-volume') return prepareVolume(argumentsList);
  if (command === 'cleanup') return cleanup(argumentsList);
  if (command === 'photos-running') return console.log(await isPhotosRunning());
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
