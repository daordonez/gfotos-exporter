import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {access, rename, stat, statfs, writeFile, readFile, mkdir, unlink} from 'node:fs/promises';
import path from 'node:path';
import {BundleDatabase} from './bundle-database.js';
import type {BundleItem, BundleManifest, BundlePaths, MetadataField, MetadataFieldStatuses, TakeoutInventory, TakeoutMetadata} from './domain.js';
import {METADATA_FIELDS, metadataFieldValue, metadataHasField} from './domain.js';
import {extractEntry, inventoryTakeout, listTakeoutArchives, readTakeoutMetadataWithState, sha256File} from './takeout.js';
import {applyTakeoutMetadata} from './media.js';
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

/**
 * Builds a per-field status record from a sidecar parse outcome and (if the item was
 * materialized) the outcome of embedding fields into the output media via ExifTool.
 *
 * - 'invalid': the sidecar JSON existed but could not be parsed.
 * - 'missing': no sidecar, or the sidecar was valid but lacked this field.
 * - 'applied' / 'unsupported': the field had a value and was (or was not) verified as embedded.
 * - 'present': the field had a value but embedding was not attempted (e.g. duplicate item).
 */
function buildFieldStatuses(sidecarState: 'present' | 'missing' | 'invalid', metadata: TakeoutMetadata, applied: MetadataFieldStatuses): MetadataFieldStatuses {
  const statuses: MetadataFieldStatuses = {};
  for (const field of METADATA_FIELDS) {
    if (sidecarState === 'invalid') {
      statuses[field] = 'invalid';
      continue;
    }
    if (!metadataHasField(metadata, field)) {
      statuses[field] = 'missing';
      continue;
    }
    statuses[field] = applied[field] ?? 'present';
  }
  return statuses;
}

function recordFieldConflicts(
  database: BundleDatabase,
  hash: string,
  canonical: {metadata: TakeoutMetadata; sourceArchive: string; sourceEntry: string},
  duplicate: {metadata: TakeoutMetadata; sourceArchive: string; sourceEntry: string}
): void {
  for (const field of METADATA_FIELDS) {
    const canonicalValue = metadataFieldValue(canonical.metadata, field);
    const duplicateValue = metadataFieldValue(duplicate.metadata, field);
    if (canonicalValue === duplicateValue) continue;
    if (canonicalValue === undefined && duplicateValue === undefined) continue;
    database.recordConflict(hash, field as MetadataField, canonicalValue, canonical.sourceArchive, canonical.sourceEntry);
    database.recordConflict(hash, field as MetadataField, duplicateValue, duplicate.sourceArchive, duplicate.sourceEntry);
  }
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
    let manifest: BundleManifest;
    try {
      manifest = JSON.parse(text) as BundleManifest;
    } catch {
      throw new Error('Corrupt bundle manifest: JSON could not be parsed.');
    }
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
    throw new Error('Bundle state is corrupt: manifest is missing required fields. To start fresh, use a new empty destination or clear both import/ and .gfotos-migrator/.');
  }
  if (manifest.sourceFingerprint !== fingerprint) {
    throw new Error('Bundle was prepared for a different source. Use the same Takeout source to resume, or start fresh on a new empty destination by clearing both import/ and .gfotos-migrator/.');
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

        // Extract the sidecar (if any) to a temp location so we can normalize its metadata
        // regardless of whether this candidate ends up materialized or as a duplicate.
        const hasSidecar = candidate.sidecarEntryPath !== undefined;
        let sidecarTempPath: string | undefined;
        if (hasSidecar && candidate.sidecarEntryPath) {
          const sidecarArchive = candidate.sidecarArchivePath ?? candidate.archivePath;
          sidecarTempPath = path.join(tempDir, `${archiveName}-${Date.now()}-${path.basename(candidate.sidecarEntryPath)}`);
          await extractEntry(sidecarArchive, candidate.sidecarEntryPath, sidecarTempPath).catch(() => { sidecarTempPath = undefined; });
        }
        const {metadata, state: sidecarState} = await readTakeoutMetadataWithState(sidecarTempPath);

        // Check if this hash is already materialized (deduplication)
        const canonical = database.find(hash);
        if (canonical?.state === 'materialized') {
          const item: BundleItem = {
            hash,
            archiveName,
            entryPath: candidate.entryPath,
            mediaKind: candidate.kind,
            state: 'duplicate',
            hasSidecar,
            canonicalHash: hash
          };
          database.save(item);

          // Compare against the canonical item's normalized metadata and record any divergent values.
          const canonicalMetadata = database.getItemMetadata(hash);
          if (canonicalMetadata) {
            recordFieldConflicts(
              database,
              hash,
              {metadata: canonicalMetadata.metadata, sourceArchive: canonicalMetadata.sourceArchive, sourceEntry: canonicalMetadata.sourceEntry},
              {metadata, sourceArchive: archiveName, sourceEntry: candidate.entryPath}
            );
          }

          progress.duplicate++;
          // Clean up temp files
          await unlink(tempFile).catch(() => undefined);
          if (sidecarTempPath) await unlink(sidecarTempPath).catch(() => undefined);
        } else {
          const flatName = await safeImportFilename(paths.importPath, path.basename(candidate.entryPath));
          const finalDest = path.join(paths.importPath, flatName);
          await rename(tempFile, finalDest);

          // Preserve the original sidecar JSON verbatim in the hidden bundle area.
          if (sidecarTempPath) {
            const sidecarDest = path.join(paths.sidecarsPath, `${hash}.json`);
            await rename(sidecarTempPath, sidecarDest).catch(() => undefined);
          }

          // Embed supported fields into the output media and record what was applied.
          const applied = await applyTakeoutMetadata(finalDest, candidate.kind, metadata).catch(() => ({}) as MetadataFieldStatuses);
          const fieldStatuses = buildFieldStatuses(sidecarState, metadata, applied);
          database.saveItemMetadata({hash, sidecarState, metadata, fieldStatuses, sourceArchive: archiveName, sourceEntry: candidate.entryPath});

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
    manifest.metadataCounts = database.countMetadata();
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
    const metadataCounts = manifest.metadataCounts ?? database.countMetadata();
    const conflicts = database.listConflicts();
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
      '## Metadata',
      '',
      'Field-level counts across all materialized and duplicate items. "Preserved" (present/applied/unsupported) means a normalized metadata record exists; "applied" means the field was verified as embedded into the output media via ExifTool.',
      '',
      '| Status | Count |',
      '| --- | ---: |',
      `| present (preserved, embedding not attempted) | ${metadataCounts.present - metadataCounts.applied - metadataCounts.unsupported} |`,
      `| applied (embedded into output media) | ${metadataCounts.applied} |`,
      `| unsupported (could not be embedded for this format) | ${metadataCounts.unsupported} |`,
      `| missing (no value in sidecar) | ${metadataCounts.missing} |`,
      `| invalid (sidecar JSON could not be parsed) | ${metadataCounts.invalid} |`,
      `| conflicting (same hash, divergent sidecar values) | ${metadataCounts.conflicting} |`,
      '',
      '### Conflicts',
      '',
      conflicts.length === 0
        ? 'No metadata conflicts detected.'
        : '| SHA-256 (prefix) | Field | Value | Source archive | Source entry |\n| --- | --- | --- | --- | --- |\n' +
          conflicts.flatMap(conflict =>
            conflict.values.map(value =>
              `| ${conflict.hash.slice(0, 12)} | ${conflict.field} | ${value.value.replaceAll('|', '\\|')} | ${value.sourceArchive.replaceAll('|', '\\|')} | ${value.sourceEntry.replaceAll('|', '\\|')} |`
            )
          ).join('\n'),
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
