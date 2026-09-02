import {createHash} from 'node:crypto';
import {rename, stat, writeFile, readFile, mkdir, copyFile} from 'node:fs/promises';
import path from 'node:path';
import {BundleDatabase} from './bundle-database.js';
import type {BundleItem, BundleManifest, BundlePaths, MetadataFieldName, TakeoutMetadata} from './domain.js';
import {extractEntry, inventoryTakeout, listTakeoutArchives, parseTakeoutSidecar, removeIfExists, sha256File} from './takeout.js';
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

/**
 * A minimal, comparable snapshot of the fields we can embed via ExifTool. Used to detect
 * whether two sidecars for the same content hash carry divergent values (a "metadata conflict").
 */
interface MetadataSnapshot {
  date?: string;
  title?: string;
  description?: string;
  gps?: string;
}

function toMetadataSnapshot(metadata: TakeoutMetadata): MetadataSnapshot {
  const snapshot: MetadataSnapshot = {};
  if (metadata.takenAt) snapshot.date = metadata.takenAt.toISOString();
  if (metadata.title) snapshot.title = metadata.title;
  if (metadata.description) snapshot.description = metadata.description;
  if (typeof metadata.latitude === 'number' && typeof metadata.longitude === 'number') {
    snapshot.gps = `${metadata.latitude},${metadata.longitude},${metadata.altitude ?? ''}`;
  }
  return snapshot;
}

interface SnapshotDiff {
  field: MetadataFieldName;
  canonicalValue: string;
  conflictingValue: string;
}

const SNAPSHOT_FIELDS: Array<[MetadataFieldName, keyof MetadataSnapshot]> = [
  ['date', 'date'],
  ['title', 'title'],
  ['description', 'description'],
  ['gps', 'gps']
];

function diffMetadataSnapshots(canonical: MetadataSnapshot, candidate: MetadataSnapshot): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];
  for (const [field, key] of SNAPSHOT_FIELDS) {
    const canonicalValue = canonical[key];
    const candidateValue = candidate[key];
    if (canonicalValue !== undefined && candidateValue !== undefined && canonicalValue !== candidateValue) {
      diffs.push({field, canonicalValue, conflictingValue: candidateValue});
    }
  }
  return diffs;
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function prepareBundle(
  volumePath: string,
  sourcePath: string,
  onProgress: (progress: BundleProgress) => void
): Promise<BundleProgress> {
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
      counts: {
        total: 0, materialized: 0, duplicate: 0, failed: 0, skipped: 0, pending: 0, missingSidecar: 0,
        metadataApplied: 0, metadataPresent: 0, metadataMissing: 0, metadataInvalid: 0, metadataConflicting: 0
      }
    };
  }

  const {media} = await inventoryTakeout(sourcePath);
  const database = await BundleDatabase.open(paths.databasePath);
  const progress: BundleProgress = {completed: 0, total: media.length, materialized: 0, duplicate: 0, failed: 0, skipped: 0};

  try {
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
        const hasSidecar = candidate.sidecarEntryPath !== undefined;
        const sidecarArchive = candidate.sidecarArchivePath ?? candidate.archivePath;

        // Check if this hash is already materialized (deduplication)
        const canonical = database.find(hash);
        if (canonical?.state === 'materialized') {
          let sidecarStatus: BundleItem['sidecarStatus'] = 'missing';
          let metadataConflict = false;

          if (hasSidecar && candidate.sidecarEntryPath) {
            const tempSidecar = path.join(tempDir, `${archiveName}-${Date.now()}-dup-${path.basename(candidate.entryPath)}.json`);
            try {
              await extractEntry(sidecarArchive, candidate.sidecarEntryPath, tempSidecar);
              const duplicateParse = await parseTakeoutSidecar(tempSidecar);
              sidecarStatus = duplicateParse.status;
              if (duplicateParse.status === 'present') {
                const canonicalJson = database.getCanonicalMetadataJson(hash);
                const canonicalSnapshot: MetadataSnapshot = canonicalJson ? JSON.parse(canonicalJson) as MetadataSnapshot : {};
                const duplicateSnapshot = toMetadataSnapshot(duplicateParse.metadata);
                const diffs = diffMetadataSnapshots(canonicalSnapshot, duplicateSnapshot);
                if (diffs.length > 0) {
                  metadataConflict = true;
                  database.markMetadataConflict(canonical.archiveName, canonical.entryPath);
                  for (const diff of diffs) {
                    database.addMetadataConflict({
                      hash,
                      field: diff.field,
                      canonicalArchiveName: canonical.archiveName,
                      canonicalEntryPath: canonical.entryPath,
                      canonicalValue: diff.canonicalValue,
                      conflictingArchiveName: archiveName,
                      conflictingEntryPath: candidate.entryPath,
                      conflictingValue: diff.conflictingValue
                    });
                  }
                  // Preserve this diverging sidecar's raw JSON, distinct from the canonical copy already at `<hash>.json`.
                  const conflictDest = path.join(
                    paths.sidecarsPath,
                    `${hash}.conflict-${sanitizeForFilename(archiveName)}-${sanitizeForFilename(candidate.entryPath)}.json`
                  );
                  await copyFile(tempSidecar, conflictDest).catch(() => undefined);
                }
              }
            } catch {
              sidecarStatus = 'missing';
            } finally {
              await removeIfExists(tempSidecar);
            }
          }

          const item: BundleItem = {
            hash,
            archiveName,
            entryPath: candidate.entryPath,
            mediaKind: candidate.kind,
            state: 'duplicate',
            hasSidecar,
            sidecarStatus,
            metadataApplied: false,
            metadataConflict,
            canonicalHash: hash
          };
          database.save(item);
          progress.duplicate++;
          await removeIfExists(tempFile);
        } else {
          const flatName = await safeImportFilename(paths.importPath, path.basename(candidate.entryPath));
          const finalDest = path.join(paths.importPath, flatName);
          await rename(tempFile, finalDest);

          // Extract sidecar if present (preserved verbatim, read-only, under sidecars/<hash>.json).
          let sidecarDest: string | undefined;
          if (hasSidecar && candidate.sidecarEntryPath) {
            sidecarDest = path.join(paths.sidecarsPath, `${hash}.json`);
            await extractEntry(sidecarArchive, candidate.sidecarEntryPath, sidecarDest).catch(() => undefined);
          }

          const sidecarParse = await parseTakeoutSidecar(sidecarDest);
          const applyResult = await applyTakeoutMetadata(finalDest, candidate.kind, sidecarParse.metadata)
            .catch(() => ({applied: [] as MetadataFieldName[], unsupported: [] as MetadataFieldName[]}));

          const item: BundleItem = {
            hash,
            archiveName,
            entryPath: candidate.entryPath,
            mediaKind: candidate.kind,
            state: 'materialized',
            hasSidecar,
            sidecarStatus: sidecarParse.status,
            metadataApplied: applyResult.applied.length > 0,
            metadataConflict: false,
            appliedFields: applyResult.applied,
            unsupportedFields: applyResult.unsupported,
            finalPath: flatName
          };
          const metadataJson = sidecarParse.status === 'present' ? JSON.stringify(toMetadataSnapshot(sidecarParse.metadata)) : undefined;
          database.save(item, metadataJson);
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
          sidecarStatus: 'missing',
          metadataApplied: false,
          metadataConflict: false,
          error: errorMessage
        });
        await removeIfExists(tempFile);
        progress.failed++;
      }

      progress.completed++;
      onProgress({...progress});
    }

    // Update manifest counts
    const stateCounts = database.countByState();
    const missingSidecar = database.countMissingSidecars();
    const metadataCounts = database.countMetadataStatus();
    manifest.updatedAt = new Date().toISOString();
    manifest.counts = {
      total: media.length,
      materialized: stateCounts.materialized,
      duplicate: stateCounts.duplicate,
      failed: stateCounts.failed,
      skipped: stateCounts.skipped,
      pending: stateCounts.pending,
      missingSidecar,
      metadataApplied: metadataCounts.applied,
      metadataPresent: metadataCounts.present,
      metadataMissing: metadataCounts.missing,
      metadataInvalid: metadataCounts.invalid,
      metadataConflicting: metadataCounts.conflicting
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
  if (!manifest) throw new Error('No bundle found at the specified volume. Run bundle-prepare first.');
  return manifest;
}

export async function writeBundleReport(volumePath: string): Promise<string> {
  const paths = await initializeBundlePaths(volumePath);
  const manifest = await loadManifest(paths);
  if (!manifest) throw new Error('No bundle found at the specified volume. Run bundle-prepare first.');
  const database = await BundleDatabase.open(paths.databasePath);
  try {
    const items = database.listItems();
    const duplicates = database.listDuplicates();
    const conflicts = database.listMetadataConflicts();
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
      'Notes:',
      '- `metadataPresent`: sidecar JSON was found and parsed (raw values preserved verbatim under `sidecars/` and indexed in `bundle.sqlite`).',
      '- `metadataApplied`: at least one field (date, title, description, or GPS) was written into the materialized media file via ExifTool.',
      '- `metadataMissing`/`metadataInvalid`: no sidecar was found, or its JSON could not be parsed; the media item is still materialized.',
      '- `metadataConflicting`: distinct content hashes with divergent sidecar values across duplicate copies; see the Metadata Conflicts section below.',
      '',
      '## Items',
      '',
      '| State | Type | Archive | Entry | SHA-256 | Sidecar | Metadata applied | Conflict | Fields applied | Fields unsupported | Final path |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...items.map(item =>
        `| ${item.state} | ${item.mediaKind} | ${item.archiveName.replaceAll('|', '\\|')} | ${item.entryPath.replaceAll('|', '\\|')} | ${item.hash.slice(0, 12)} | ${item.sidecarStatus} | ${item.metadataApplied ? 'yes' : 'no'} | ${item.metadataConflict ? 'yes' : 'no'} | ${(item.appliedFields ?? []).join(', ')} | ${(item.unsupportedFields ?? []).join(', ')} | ${(item.finalPath ?? '').replaceAll('|', '\\|')} |`
      ),
      '',
      '## Duplicates',
      '',
      `Total: ${duplicates.length}`,
      '',
      '## Metadata Conflicts',
      '',
      `Total: ${conflicts.length}`,
      ''
    ];
    if (conflicts.length > 0) {
      lines.push(
        '| SHA-256 | Field | Canonical (archive/entry) | Canonical value | Conflicting (archive/entry) | Conflicting value |',
        '| --- | --- | --- | --- | --- | --- |',
        ...conflicts.map(conflict =>
          `| ${conflict.hash.slice(0, 12)} | ${conflict.field} | ${conflict.canonicalArchiveName}/${conflict.canonicalEntryPath} | ${conflict.canonicalValue.replaceAll('|', '\\|')} | ${conflict.conflictingArchiveName}/${conflict.conflictingEntryPath} | ${conflict.conflictingValue.replaceAll('|', '\\|')} |`
        ),
        ''
      );
    }
    const report = lines.join('\n');
    const destination = path.join(paths.reportsPath, `bundle-${new Date().toISOString().replaceAll(':', '-')}.md`);
    await writeFile(destination, report, {mode: 0o600});
    return destination;
  } finally {
    database.close();
  }
}
