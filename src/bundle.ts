import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access, rename, stat, statfs, writeFile, readFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {BundleDatabase} from './bundle-database.js';
import type {BundleItem, BundleManifest, BundlePaths, TakeoutInventory} from './domain.js';
import {extractEntry, inventoryTakeout, listTakeoutArchives, sha256File} from './takeout.js';
import {ensureDirectory} from './system.js';

export interface BundleProgress {
  completed: number;
  total: number;
  materialized: number;
  duplicate: number;
  failed: number;
  skipped: number;
  current?: string;
}

export interface BundleVolumeInfo {
  path: string;
  writable: boolean;
  availableBytes: number;
  requiredBytes: number;
  sufficient: boolean;
}

/** Bytes required on the destination volume: the uncompressed media size plus 20 percent headroom. */
export function requiredBundleBytes(inventory: TakeoutInventory): number {
  return Math.ceil(inventory.extractBytes * 1.2);
}

/**
 * Validates that a destination path is an existing, writable directory with
 * enough free space for the bundle. This check is filesystem-agnostic: it
 * accepts any writable volume, not only APFS.
 */
export async function checkBundleVolume(volumePath: string, minimumBytes = 0): Promise<BundleVolumeInfo> {
  const resolved = path.resolve(volumePath);
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new Error(`The selected volume path does not exist or is not mounted: ${resolved}`);
  }
  if (!info.isDirectory()) throw new Error(`The selected volume path is not a directory: ${resolved}`);
  try {
    await access(resolved, constants.W_OK);
  } catch {
    throw new Error(`The selected volume is not writable: ${resolved}`);
  }
  const usage = await statfs(resolved);
  const availableBytes = usage.bavail * usage.bsize;
  const sufficient = availableBytes >= minimumBytes;
  if (!sufficient) {
    throw new Error(`The selected volume does not have enough free space. Required: ${minimumBytes} bytes, available: ${availableBytes} bytes.`);
  }
  return {path: resolved, writable: true, availableBytes, requiredBytes: minimumBytes, sufficient};
}

export async function initializeBundlePaths(volumePath: string): Promise<BundlePaths> {
  const resolved = path.resolve(volumePath);
  const bundlePath = path.join(resolved, '.gfotos-migrator');
  const importPath = path.join(resolved, 'import');
  const sidecarsPath = path.join(bundlePath, 'sidecars');
  const reportsPath = path.join(bundlePath, 'reports');
  await Promise.all([
    mkdir(importPath, {recursive: true, mode: 0o755}),
    mkdir(sidecarsPath, {recursive: true, mode: 0o700}),
    mkdir(reportsPath, {recursive: true, mode: 0o700})
  ]);
  return {
    volumePath: resolved,
    importPath,
    bundlePath,
    databasePath: path.join(bundlePath, 'bundle.sqlite'),
    sidecarsPath,
    reportsPath,
    manifestPath: path.join(bundlePath, 'manifest.json')
  };
}

export async function computeSourceFingerprint(archives: string[]): Promise<string> {
  const hash = createHash('sha256');
  const sorted = [...archives].sort();
  for (const archivePath of sorted) {
    const archiveStat = await stat(archivePath);
    hash.update(`${path.basename(archivePath)}:${archiveStat.size}\n`);
  }
  return hash.digest('hex');
}

export async function loadManifest(paths: BundlePaths): Promise<BundleManifest | undefined> {
  try {
    const text = await readFile(paths.manifestPath, 'utf8');
    const manifest = JSON.parse(text) as BundleManifest;
    if (typeof manifest.version !== 'number' || typeof manifest.sourceFingerprint !== 'string') {
      throw new Error('Corrupt bundle manifest: missing required fields.');
    }
    return manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function saveManifest(paths: BundlePaths, manifest: BundleManifest): Promise<void> {
  await ensureDirectory(path.dirname(paths.manifestPath));
  await writeFile(paths.manifestPath, JSON.stringify(manifest, null, 2), {mode: 0o600});
}

export function validateBundleCompatibility(manifest: BundleManifest, fingerprint: string): void {
  if (typeof manifest.version !== 'number' || typeof manifest.sourceFingerprint !== 'string' || typeof manifest.createdAt !== 'string') {
    throw new Error('Bundle state is corrupt: manifest is missing required fields. Remove .gfotos-migrator/ to start fresh.');
  }
  if (manifest.sourceFingerprint !== fingerprint) {
    throw new Error('Bundle was prepared for a different source. Use the same Takeout source to resume, or remove .gfotos-migrator/ to start fresh.');
  }
}

export async function safeImportFilename(importPath: string, basename: string): Promise<string> {
  const ext = path.extname(basename);
  const stem = path.basename(basename, ext);
  let candidate = basename;
  let counter = 0;
  while (true) {
    try {
      await stat(path.join(importPath, candidate));
      counter++;
      candidate = `${stem}~${counter}${ext}`;
    } catch {
      return candidate;
    }
  }
}

export async function prepareBundle(
  volumePath: string,
  sourcePath: string,
  onProgress: (progress: BundleProgress) => void
): Promise<BundleProgress> {
  const {inventory, media} = await inventoryTakeout(sourcePath);
  const paths = await initializeBundlePaths(volumePath);
  const archives = await listTakeoutArchives(sourcePath);
  const fingerprint = await computeSourceFingerprint(archives);
  const existingManifest = await loadManifest(paths);

  let manifest: BundleManifest;
  if (existingManifest) {
    validateBundleCompatibility(existingManifest, fingerprint);
    manifest = existingManifest;
  } else {
    const now = new Date().toISOString();
    manifest = {
      version: 1,
      createdAt: now,
      updatedAt: now,
      sourceFingerprint: fingerprint,
      counts: {total: 0, materialized: 0, duplicate: 0, failed: 0, skipped: 0, pending: 0, missingSidecar: 0}
    };
  }

  const database = await BundleDatabase.open(paths.databasePath);
  const progress: BundleProgress = {completed: 0, total: media.length, materialized: 0, duplicate: 0, failed: 0, skipped: 0};

  try {
    // Only require free space for items that are not already materialized, duplicate, or
    // skipped, so resuming a partially completed bundle does not demand the full original
    // requirement again against space already consumed by previously written output.
    let pendingBytes = 0;
    for (const candidate of media) {
      const archiveName = path.basename(candidate.archivePath);
      const existing = database.findByEntry(archiveName, candidate.entryPath);
      if (existing?.state === 'materialized' || existing?.state === 'duplicate' || existing?.state === 'skipped') continue;
      pendingBytes += candidate.size;
    }
    await checkBundleVolume(volumePath, Math.ceil(pendingBytes * 1.2));

    for (const candidate of media) {
      const archiveName = path.basename(candidate.archivePath);
      progress.current = candidate.entryPath;

      const existing = database.findByEntry(archiveName, candidate.entryPath);
      if (existing?.state === 'materialized' || existing?.state === 'duplicate' || existing?.state === 'skipped') {
        if (existing.state === 'materialized') progress.materialized++;
        else if (existing.state === 'duplicate') progress.duplicate++;
        else progress.skipped++;
        progress.completed++;
        onProgress({...progress});
        continue;
      }

      const tempDir = path.join(paths.bundlePath, 'work');
      await mkdir(tempDir, {recursive: true, mode: 0o700});
      const tempFile = path.join(tempDir, `${archiveName}-${Date.now()}-${path.basename(candidate.entryPath)}`);

      try {
        await extractEntry(candidate.archivePath, candidate.entryPath, tempFile);
        const hash = await sha256File(tempFile);

        // Check if this hash is already materialized (deduplication)
        const canonical = database.find(hash);
        if (canonical?.state === 'materialized') {
          const item: BundleItem = {
            hash,
            archiveName,
            entryPath: candidate.entryPath,
            mediaKind: candidate.kind,
            state: 'duplicate',
            hasSidecar: candidate.sidecarEntryPath !== undefined,
            canonicalHash: hash
          };
          database.save(item);
          progress.duplicate++;
          // Clean up temp file
          await rename(tempFile, tempFile + '.del').catch(() => undefined);
          try { await stat(tempFile + '.del'); } catch { /* already gone */ }
          const {unlink} = await import('node:fs/promises');
          await unlink(tempFile + '.del').catch(() => undefined);
        } else {
          const flatName = await safeImportFilename(paths.importPath, path.basename(candidate.entryPath));
          const finalDest = path.join(paths.importPath, flatName);
          await rename(tempFile, finalDest);

          // Extract sidecar if present
          const sidecarArchive = candidate.sidecarArchivePath ?? candidate.archivePath;
          const hasSidecar = candidate.sidecarEntryPath !== undefined;
          if (hasSidecar && candidate.sidecarEntryPath) {
            const sidecarDest = path.join(paths.sidecarsPath, `${hash}.json`);
            await extractEntry(sidecarArchive, candidate.sidecarEntryPath, sidecarDest).catch(() => undefined);
          }

          const item: BundleItem = {
            hash,
            archiveName,
            entryPath: candidate.entryPath,
            mediaKind: candidate.kind,
            state: 'materialized',
            hasSidecar,
            finalPath: flatName
          };
          database.save(item);
          progress.materialized++;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Try to compute hash for error record
        let hash = 'unknown-' + archiveName + '-' + candidate.entryPath;
        try { hash = await sha256File(tempFile); } catch { /* ignore */ }
        database.save({
          hash,
          archiveName,
          entryPath: candidate.entryPath,
          mediaKind: candidate.kind,
          state: 'failed',
          hasSidecar: candidate.sidecarEntryPath !== undefined,
          error: errorMessage
        });
        // Clean up temp file
        const {unlink} = await import('node:fs/promises');
        await unlink(tempFile).catch(() => undefined);
        progress.failed++;
      }

      progress.completed++;
      onProgress({...progress});
    }

    // Update manifest counts
    const stateCounts = database.countByState();
    const missingSidecar = database.countMissingSidecars();
    manifest.updatedAt = new Date().toISOString();
    manifest.counts = {
      total: media.length,
      materialized: stateCounts.materialized,
      duplicate: stateCounts.duplicate,
      failed: stateCounts.failed,
      skipped: stateCounts.skipped,
      pending: stateCounts.pending,
      missingSidecar
    };
    await saveManifest(paths, manifest);

    return progress;
  } finally {
    database.close();
  }
}

export async function getBundleStatus(volumePath: string): Promise<BundleManifest> {
  const paths = await initializeBundlePaths(volumePath);
  const manifest = await loadManifest(paths);
  if (!manifest) throw new Error('No bundle found at the specified volume. Run `prepare` first.');
  return manifest;
}

export async function writeBundleReport(volumePath: string): Promise<string> {
  const paths = await initializeBundlePaths(volumePath);
  const manifest = await loadManifest(paths);
  if (!manifest) throw new Error('No bundle found at the specified volume. Run `prepare` first.');
  const database = await BundleDatabase.open(paths.databasePath);
  try {
    const items = database.listItems();
    const duplicates = database.listDuplicates();
    const lines: string[] = [
      '# Import Bundle Report',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Bundle version: ${manifest.version}`,
      `Created: ${manifest.createdAt}`,
      `Updated: ${manifest.updatedAt}`,
      '',
      '## Counts',
      '',
      '| Metric | Count |',
      '| --- | ---: |',
      ...Object.entries(manifest.counts).map(([k, v]) => `| ${k} | ${v} |`),
      '',
      '## Items',
      '',
      '| State | Type | Archive | Entry | SHA-256 | Final path |',
      '| --- | --- | --- | --- | --- | --- |',
      ...items.map(item =>
        `| ${item.state} | ${item.mediaKind} | ${item.archiveName.replaceAll('|', '\\|')} | ${item.entryPath.replaceAll('|', '\\|')} | ${item.hash.slice(0, 12)} | ${(item.finalPath ?? '').replaceAll('|', '\\|')} |`
      ),
      '',
      '## Duplicates',
      '',
      `Total: ${duplicates.length}`,
      ''
    ];
    const report = lines.join('\n');
    const destination = path.join(paths.reportsPath, `bundle-${new Date().toISOString().replaceAll(':', '-')}.md`);
    await writeFile(destination, report, {mode: 0o600});
    return destination;
  } finally {
    database.close();
  }
}
