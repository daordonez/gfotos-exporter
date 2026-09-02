#!/usr/bin/env node
import path from 'node:path';
import {checkBundleVolume, getBundleStatus, prepareBundle, requiredBundleBytes, writeBundleReport} from './bundle.js';
import {inventoryTakeout} from './takeout.js';
import {runTui} from './tui.js';
import {VERSION} from './version.js';

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
  gfotos-migrator inspect --source <takeout-folder> [--volume <destination-volume>]
  gfotos-migrator prepare --source <takeout-folder> --volume <destination-volume>
  gfotos-migrator resume --source <takeout-folder> --volume <destination-volume>
  gfotos-migrator status --volume <destination-volume>
  gfotos-migrator report --volume <destination-volume>

Safety:
  prepare/resume build an Import Bundle (import/ plus a .gfotos-migrator/ state directory)
  on any writable destination volume with sufficient free capacity. There is no APFS,
  disk-erase, or Photos automation requirement. Takeout ZIP archives are treated as
  read-only input and are never modified.
  After preparation, open Photos manually and import the files under the reported
  import/ path; gfotos-migrator does not automate that step.
`);
}

async function inspect(argumentsList: string[]): Promise<void> {
  const source = requiredOption(argumentsList, '--source');
  const volume = option(argumentsList, '--volume');
  const {inventory} = await inventoryTakeout(source);
  const required = requiredBundleBytes(inventory);

  let volumeInfo: unknown;
  let volumeError: string | undefined;
  if (volume) {
    try {
      volumeInfo = await checkBundleVolume(volume, required);
    } catch (error) {
      volumeError = error instanceof Error ? error.message : String(error);
    }
  }

  console.log(JSON.stringify({
    source: path.resolve(source),
    inventory,
    requiredBytes: required,
    volume: volumeInfo,
    volumeError,
    nextStep: volume
      ? (volumeError ? 'Resolve the reported volume issue, then run prepare.' : 'Run prepare to build the Import Bundle on the selected volume.')
      : 'Pass --volume to validate a destination volume, then run prepare.'
  }, null, 2));

  if (volumeError) process.exitCode = 2;
}

async function prepare(argumentsList: string[]): Promise<void> {
  const source = requiredOption(argumentsList, '--source');
  const volume = requiredOption(argumentsList, '--volume');
  const result = await prepareBundle(path.resolve(volume), source, progress => {
    process.stdout.write(`\r${progress.completed}/${progress.total} processed | ${progress.materialized} materialized | ${progress.duplicate} duplicate | ${progress.failed} failed`);
  });
  process.stdout.write('\n');
  console.log(JSON.stringify(result, null, 2));
}

async function status(argumentsList: string[]): Promise<void> {
  const volume = requiredOption(argumentsList, '--volume');
  const manifest = await getBundleStatus(path.resolve(volume));
  console.log(JSON.stringify(manifest, null, 2));
}

async function report(argumentsList: string[]): Promise<void> {
  const volume = requiredOption(argumentsList, '--volume');
  const reportPath = await writeBundleReport(path.resolve(volume));
  console.log(reportPath);
}

async function main(): Promise<void> {
  const [command = 'guided-migration', ...argumentsList] = process.argv.slice(2);
  if (command === '--help' || command === '-h' || command === 'help') return printHelp();
  if (command === '--version' || command === '-v') return console.log(VERSION);
  if (command === 'guided-migration') return runTui();
  if (command === 'inspect') return inspect(argumentsList);
  if (command === 'prepare' || command === 'resume') return prepare(argumentsList);
  if (command === 'status') return status(argumentsList);
  if (command === 'report') return report(argumentsList);
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
