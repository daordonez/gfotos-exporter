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

const execute = promisify(execFile);

test('rejects unsafe archive paths', () => {
  assert.equal(isSafeArchivePath('../escape.jpg'), false);
  assert.equal(isSafeArchivePath('/absolute.jpg'), false);
  assert.equal(isSafeArchivePath('Album/photo.jpg'), true);
});

test('adds migration storage headroom', () => {
  assert.equal(requiredBytes({archives: 1, images: 1, videos: 0, compressedBytes: 10, extractBytes: 100, rejectedEntries: 0}), 120);
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
