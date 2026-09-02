#!/usr/bin/env node
import path from 'node:path';
import {inventoryTakeout} from './takeout.js';
import {requiredBytes} from './migration.js';
import {inspectVolume} from './volume.js';
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
  gfotos-migrator inspect --source <takeout-folder> [--volume <volume>]
  gfotos-migrator prepare --source <takeout-folder> --volume <volume>
  gfotos-migrator resume --source <takeout-folder> --volume <volume>
  gfotos-migrator status --volume <volume>
  gfotos-migrator report --volume <volume>

Safety:
  prepare/resume build a portable Import Bundle under <volume>/import and
  <volume>/.gfotos-migrator on any writable volume without APFS or
  formatting requirements. Bringing the resulting import/ folder into
  Photos remains a manual step performed by the operator.
`);
}

async function inspect(argumentsList: string[]): Promise<void> {
  const source = requiredOption(argumentsList, '--source');
  const volume = option(argumentsList, '--volume');
  const {inventory} = await inventoryTakeout(source);
  const bytesNeeded = requiredBytes(inventory);
  const result: {ok: boolean; source: string; inventory: typeof inventory; requiredBytes: number; volume?: Awaited<ReturnType<typeof inspectVolume>>} = {
    ok: inventory.archives > 0,
    source: path.resolve(source),
    inventory,
    requiredBytes: bytesNeeded
  };
  if (volume) {
    const volumeInfo = await inspectVolume(path.resolve(volume));
    result.volume = volumeInfo;
    result.ok = result.ok && volumeInfo.availableBytes >= bytesNeeded;
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
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

async function status(volume: string): Promise<void> {
  const manifest = await getBundleStatus(path.resolve(volume));
  console.log(JSON.stringify(manifest, null, 2));
}

async function report(volume: string): Promise<void> {
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
  if (command === 'status') return status(requiredOption(argumentsList, '--volume'));
  if (command === 'report') return report(requiredOption(argumentsList, '--volume'));
  throw new Error(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
