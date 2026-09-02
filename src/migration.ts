import path from 'node:path';
import {mkdir, rm} from 'node:fs/promises';
import type {MediaCandidate, MigrationPaths, TakeoutInventory} from './domain.js';
import {MigrationDatabase} from './database.js';
import {applyTakeoutMetadata} from './media.js';
import {importIntoOpenPhotosLibrary} from './photos.js';
import {extractEntry, readTakeoutMetadata, removeIfExists, sha256File} from './takeout.js';

export interface ImportProgress {
  completed: number;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
  current?: MediaCandidate;
}

export async function initializePaths(volumePath: string): Promise<MigrationPaths> {
  const root = path.join(volumePath, '.gfotos-migrator');
  const workPath = path.join(root, 'work');
  const reportPath = path.join(root, 'reports');
  await Promise.all([mkdir(workPath, {recursive: true, mode: 0o700}), mkdir(reportPath, {recursive: true, mode: 0o700})]);
  return {volumePath, libraryPath: path.join(volumePath, 'GoogleTakeoutMigration.photoslibrary'), workPath, databasePath: path.join(root, 'migration.sqlite'), reportPath};
}

export function requiredBytes(inventory: TakeoutInventory): number {
  return Math.ceil(inventory.extractBytes * 1.2);
}

export async function importCandidates(paths: MigrationPaths, candidates: MediaCandidate[], onProgress: (progress: ImportProgress) => void): Promise<ImportProgress> {
  const database = await MigrationDatabase.open(paths.databasePath);
  const progress: ImportProgress = {completed: 0, total: candidates.length, imported: 0, skipped: 0, failed: 0};
  try {
    for (const candidate of candidates) {
      progress.current = candidate;
      const itemDirectory = path.join(paths.workPath, `${progress.completed}`);
      const filePath = path.join(itemDirectory, path.basename(candidate.entryPath));
      const jsonPath = candidate.sidecarEntryPath ? path.join(itemDirectory, path.basename(candidate.sidecarEntryPath)) : undefined;
      try {
        await mkdir(itemDirectory, {recursive: true, mode: 0o700});
        await extractEntry(candidate.archivePath, candidate.entryPath, filePath);
        const hash = await sha256File(filePath);
        const existing = database.find(hash);
        if (existing?.status === 'imported' || existing?.status === 'unknown') {
          progress.skipped++;
          await rm(itemDirectory, {recursive: true, force: true});
        } else {
          database.save({hash, archivePath: candidate.archivePath, entryPath: candidate.entryPath, mediaKind: candidate.kind, status: 'pending'});
          if (candidate.sidecarEntryPath && jsonPath) await extractEntry(candidate.sidecarArchivePath ?? candidate.archivePath, candidate.sidecarEntryPath, jsonPath);
          const metadata = await readTakeoutMetadata(jsonPath);
          await applyTakeoutMetadata(filePath, candidate.kind, metadata).catch(() => ({}));
          await importIntoOpenPhotosLibrary(filePath);
          database.save({hash, archivePath: candidate.archivePath, entryPath: candidate.entryPath, mediaKind: candidate.kind, status: 'imported'});
          progress.imported++;
          await rm(itemDirectory, {recursive: true, force: true});
        }
      } catch (error) {
        progress.failed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        try {
          const hash = await sha256File(filePath);
          database.save({hash, archivePath: candidate.archivePath, entryPath: candidate.entryPath, mediaKind: candidate.kind, status: 'failed', error: errorMessage});
        } catch {
          await removeIfExists(filePath);
        }
      }
      progress.completed++;
      onProgress({...progress});
    }
    return progress;
  } finally {
    database.close();
  }
}
