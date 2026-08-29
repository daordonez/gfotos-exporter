import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {MigrationDatabase} from '../dist/database.js';
import {requiredBytes} from '../dist/migration.js';
import {isSafeArchivePath} from '../dist/system.js';
import {inventoryTakeout} from '../dist/takeout.js';
import {findAvailableUpdate} from '../dist/updates.js';
import {isSelectableExternalVolume, parentWholeDiskIdentifier, volumeMountPath} from '../dist/volume.js';

const execute = promisify(execFile);

test('rejects unsafe archive paths', () => {
  assert.equal(isSafeArchivePath('../escape.jpg'), false);
  assert.equal(isSafeArchivePath('/absolute.jpg'), false);
  assert.equal(isSafeArchivePath('Album/photo.jpg'), true);
});

test('adds migration storage headroom', () => {
  assert.equal(requiredBytes({archives: 1, images: 1, videos: 0, compressedBytes: 10, extractBytes: 100, rejectedEntries: 0}), 120);
});

test('creates safe APFS volume mount paths', () => {
  assert.equal(volumeMountPath('Google Migration'), '/Volumes/Google Migration');
  assert.throws(() => volumeMountPath('../unsafe'));
  assert.throws(() => volumeMountPath(''));
});

test('accepts external mounted volumes regardless of their filesystem but excludes critical destinations', () => {
  const selectable = {mountPoint: '/Volumes/Migration', filesystem: 'exfat', availableBytes: 100, capacityBytes: 200, isExternal: true, isReadOnly: false};
  assert.equal(isSelectableExternalVolume(selectable), true);
  assert.equal(isSelectableExternalVolume({...selectable, isExternal: false}), false);
  assert.equal(isSelectableExternalVolume({...selectable, isReadOnly: true}), false);
  assert.equal(isSelectableExternalVolume({...selectable, mountPoint: '/System/Volumes/Data'}), false);
  assert.equal(isSelectableExternalVolume(selectable, ['/Volumes/Migration']), false);
});

test('resolves only a whole-disk identifier for formatting', () => {
  assert.equal(parentWholeDiskIdentifier('disk4s2', 'disk4'), 'disk4');
  assert.equal(parentWholeDiskIdentifier('disk4s2', undefined), 'disk4');
  assert.throws(() => parentWholeDiskIdentifier('disk4s2', 'disk4s2'));
});

test('persists migration state by media hash', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-migrator-'));
  const database = await MigrationDatabase.open(path.join(directory, 'state.sqlite'));
  try {
    database.save({hash: 'a'.repeat(64), archivePath: '/takeout.zip', entryPath: 'photo.jpg', mediaKind: 'image', status: 'pending'});
    database.save({hash: 'a'.repeat(64), archivePath: '/takeout.zip', entryPath: 'photo.jpg', mediaKind: 'image', status: 'imported'});
    assert.equal(database.find('a'.repeat(64))?.status, 'imported');
    assert.equal(database.countByStatus().imported, 1);
  } finally {
    database.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('inventories photos and videos from a Takeout ZIP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gfotos-migrator-'));
  try {
    await writeFile(path.join(directory, 'photo.jpg'), 'photo');
    await writeFile(path.join(directory, 'photo.jpg.json'), JSON.stringify({photoTakenTime: {timestamp: '1700000000'}}));
    await writeFile(path.join(directory, 'clip.mov'), 'video');
    await execute('/usr/bin/zip', ['takeout.zip', 'photo.jpg', 'photo.jpg.json', 'clip.mov'], {cwd: directory});
    const result = await inventoryTakeout(path.join(directory, 'takeout.zip'));
    assert.equal(result.inventory.images, 1);
    assert.equal(result.inventory.videos, 1);
    assert.equal(result.media.find(item => item.entryPath === 'photo.jpg')?.sidecarPath, 'photo.jpg.json');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('selects the newest stable release with its matching package', () => {
  const update = findAvailableUpdate([
    {tag_name: 'v0.1.1', draft: false, prerelease: false, assets: [{id: 11, name: 'gfotos-migrator-0.1.1.tgz'}]},
    {tag_name: 'v0.2.0-beta.1', draft: false, prerelease: true, assets: [{id: 12, name: 'gfotos-migrator-0.2.0-beta.1.tgz'}]},
    {tag_name: 'v0.2.0', draft: false, prerelease: false, assets: [{id: 13, name: 'gfotos-migrator-0.2.0.tgz'}]},
    {tag_name: 'v0.3.0', draft: false, prerelease: false, assets: []}
  ], '0.1.0');
  assert.deepEqual(update, {version: '0.2.0', assetId: 13, packageName: 'gfotos-migrator-0.2.0.tgz'});
});

test('does not suggest draft, prerelease, malformed, or older releases', () => {
  const update = findAvailableUpdate([
    {tag_name: 'v0.2.0', draft: true, prerelease: false, assets: [{id: 1, name: 'gfotos-migrator-0.2.0.tgz'}]},
    {tag_name: 'v0.1.1-rc.1', draft: false, prerelease: true, assets: [{id: 2, name: 'gfotos-migrator-0.1.1-rc.1.tgz'}]},
    {tag_name: 'latest', draft: false, prerelease: false, assets: [{id: 3, name: 'gfotos-migrator-latest.tgz'}]},
    {tag_name: 'v0.1.0', draft: false, prerelease: false, assets: [{id: 4, name: 'gfotos-migrator-0.1.0.tgz'}]}
  ], '0.1.0');
  assert.equal(update, undefined);
});

test('exports version from package.json', async () => {
  const {VERSION} = await import('../dist/version.js');
  const {createRequire} = await import('node:module');
  const require = createRequire(import.meta.url);
  const packageInfo = require('../package.json');
  assert.equal(VERSION, packageInfo.version);
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

