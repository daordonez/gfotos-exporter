import type {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {ensureDirectory} from './system.js';
import type {BundleItem, BundleItemState, MediaKind, MetadataConflictEntry, MetadataFieldName, SidecarStatus} from './domain.js';

export class BundleDatabase {
  private readonly database: DatabaseSync;

  static async open(databasePath: string): Promise<BundleDatabase> {
    await ensureDirectory(path.dirname(databasePath));
    const {DatabaseSync} = await import('node:sqlite');
    return new BundleDatabase(new DatabaseSync(databasePath));
  }

  private constructor(database: DatabaseSync) {
    this.database = database;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS bundle_items (
        hash TEXT NOT NULL,
        archive_name TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        media_kind TEXT NOT NULL,
        state TEXT NOT NULL,
        final_path TEXT,
        canonical_hash TEXT,
        error TEXT,
        has_sidecar INTEGER NOT NULL DEFAULT 0,
        sidecar_status TEXT NOT NULL DEFAULT 'missing',
        metadata_applied INTEGER NOT NULL DEFAULT 0,
        metadata_conflict INTEGER NOT NULL DEFAULT 0,
        applied_fields TEXT,
        unsupported_fields TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (archive_name, entry_path)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS bundle_items_hash ON bundle_items(hash);
      CREATE TABLE IF NOT EXISTS metadata_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        field TEXT NOT NULL,
        canonical_archive_name TEXT NOT NULL,
        canonical_entry_path TEXT NOT NULL,
        canonical_value TEXT,
        conflicting_archive_name TEXT NOT NULL,
        conflicting_entry_path TEXT NOT NULL,
        conflicting_value TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
      CREATE INDEX IF NOT EXISTS metadata_conflicts_hash ON metadata_conflicts(hash);
    `);
  }

  find(hash: string): BundleItem | undefined {
    const row = this.database
      .prepare(`SELECT ${SELECT_COLUMNS} FROM bundle_items WHERE hash = ? AND state = 'materialized' LIMIT 1`)
      .get(hash) as RawRow | undefined;
    return row ? toItem(row) : undefined;
  }

  findByEntry(archiveName: string, entryPath: string): BundleItem | undefined {
    const row = this.database
      .prepare(`SELECT ${SELECT_COLUMNS} FROM bundle_items WHERE archive_name = ? AND entry_path = ?`)
      .get(archiveName, entryPath) as RawRow | undefined;
    return row ? toItem(row) : undefined;
  }

  /** Returns the canonical parsed metadata (as recorded when it was materialized) for conflict comparisons. */
  getCanonicalMetadataJson(hash: string): string | undefined {
    const row = this.database
      .prepare("SELECT metadata_json AS metadataJson FROM bundle_items WHERE hash = ? AND state = 'materialized' LIMIT 1")
      .get(hash) as {metadataJson: string | null} | undefined;
    return row?.metadataJson ?? undefined;
  }

  /**
   * Persists a bundle item. `metadataJson` is an optional serialized snapshot of the parsed
   * sidecar metadata, stored only for materialized items so later duplicates can be compared
   * against the canonical values for conflict detection.
   */
  save(item: BundleItem, metadataJson?: string): void {
    this.database.prepare(`
      INSERT INTO bundle_items (
        hash, archive_name, entry_path, media_kind, state, final_path, canonical_hash, error, has_sidecar,
        sidecar_status, metadata_applied, metadata_conflict, applied_fields, unsupported_fields, metadata_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(archive_name, entry_path) DO UPDATE SET
        hash = excluded.hash,
        state = excluded.state,
        final_path = excluded.final_path,
        canonical_hash = excluded.canonical_hash,
        error = excluded.error,
        has_sidecar = excluded.has_sidecar,
        sidecar_status = excluded.sidecar_status,
        metadata_applied = excluded.metadata_applied,
        metadata_conflict = excluded.metadata_conflict,
        applied_fields = excluded.applied_fields,
        unsupported_fields = excluded.unsupported_fields,
        metadata_json = COALESCE(excluded.metadata_json, bundle_items.metadata_json),
        updated_at = CURRENT_TIMESTAMP
    `).run(
      item.hash,
      item.archiveName,
      item.entryPath,
      item.mediaKind,
      item.state,
      item.finalPath ?? null,
      item.canonicalHash ?? null,
      item.error ?? null,
      item.hasSidecar ? 1 : 0,
      item.sidecarStatus ?? 'missing',
      item.metadataApplied ? 1 : 0,
      item.metadataConflict ? 1 : 0,
      item.appliedFields && item.appliedFields.length > 0 ? item.appliedFields.join(',') : null,
      item.unsupportedFields && item.unsupportedFields.length > 0 ? item.unsupportedFields.join(',') : null,
      metadataJson ?? null
    );
  }

  /** Marks a bundle item (typically the canonical materialized record) as having a known metadata conflict. */
  markMetadataConflict(archiveName: string, entryPath: string): void {
    this.database
      .prepare('UPDATE bundle_items SET metadata_conflict = 1 WHERE archive_name = ? AND entry_path = ?')
      .run(archiveName, entryPath);
  }

  addMetadataConflict(entry: MetadataConflictEntry): void {
    this.database.prepare(`
      INSERT INTO metadata_conflicts (
        hash, field, canonical_archive_name, canonical_entry_path, canonical_value,
        conflicting_archive_name, conflicting_entry_path, conflicting_value
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.hash,
      entry.field,
      entry.canonicalArchiveName,
      entry.canonicalEntryPath,
      entry.canonicalValue,
      entry.conflictingArchiveName,
      entry.conflictingEntryPath,
      entry.conflictingValue
    );
  }

  listMetadataConflicts(): MetadataConflictEntry[] {
    return (this.database
      .prepare(`
        SELECT hash, field, canonical_archive_name AS canonicalArchiveName, canonical_entry_path AS canonicalEntryPath,
               canonical_value AS canonicalValue, conflicting_archive_name AS conflictingArchiveName,
               conflicting_entry_path AS conflictingEntryPath, conflicting_value AS conflictingValue
        FROM metadata_conflicts ORDER BY id ASC
      `)
      .all() as unknown) as MetadataConflictEntry[];
  }

  listDuplicates(): Array<{hash: string; canonicalHash: string}> {
    return this.database
      .prepare("SELECT hash, canonical_hash AS canonicalHash FROM bundle_items WHERE state = 'duplicate'")
      .all() as Array<{hash: string; canonicalHash: string}>;
  }

  countByState(): Record<BundleItemState, number> {
    const counts: Record<BundleItemState, number> = {pending: 0, materialized: 0, duplicate: 0, failed: 0, skipped: 0};
    for (const row of this.database.prepare('SELECT state, COUNT(*) AS count FROM bundle_items GROUP BY state').all() as Array<{state: BundleItemState; count: number}>) {
      counts[row.state] = row.count;
    }
    return counts;
  }

  countMissingSidecars(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM bundle_items WHERE has_sidecar = 0 AND state = 'materialized'")
      .get() as {count: number};
    return row.count;
  }

  /** Aggregate metadata status counts across materialized and duplicate items (each source occurrence counted once). */
  countMetadataStatus(): {applied: number; present: number; missing: number; invalid: number; conflicting: number} {
    const row = this.database
      .prepare(`
        SELECT
          SUM(CASE WHEN metadata_applied = 1 THEN 1 ELSE 0 END) AS applied,
          SUM(CASE WHEN sidecar_status = 'present' THEN 1 ELSE 0 END) AS present,
          SUM(CASE WHEN sidecar_status = 'missing' THEN 1 ELSE 0 END) AS missing,
          SUM(CASE WHEN sidecar_status = 'invalid' THEN 1 ELSE 0 END) AS invalid
        FROM bundle_items WHERE state IN ('materialized', 'duplicate')
      `)
      .get() as {applied: number | null; present: number | null; missing: number | null; invalid: number | null};
    const conflictingRow = this.database
      .prepare("SELECT COUNT(DISTINCT hash) AS count FROM bundle_items WHERE metadata_conflict = 1")
      .get() as {count: number};
    return {
      applied: row.applied ?? 0,
      present: row.present ?? 0,
      missing: row.missing ?? 0,
      invalid: row.invalid ?? 0,
      conflicting: conflictingRow.count
    };
  }

  listItems(): BundleItem[] {
    return (this.database
      .prepare(`SELECT ${SELECT_COLUMNS} FROM bundle_items ORDER BY updated_at ASC`)
      .all() as unknown as RawRow[]).map(toItem);
  }

  close(): void {
    this.database.close();
  }
}

const SELECT_COLUMNS = `
  hash, archive_name AS archiveName, entry_path AS entryPath, media_kind AS mediaKind, state,
  final_path AS finalPath, canonical_hash AS canonicalHash, error, has_sidecar AS hasSidecar,
  sidecar_status AS sidecarStatus, metadata_applied AS metadataApplied, metadata_conflict AS metadataConflict,
  applied_fields AS appliedFields, unsupported_fields AS unsupportedFields
`;

interface RawRow {
  hash: string;
  archiveName: string;
  entryPath: string;
  mediaKind: string;
  state: string;
  finalPath: string | null;
  canonicalHash: string | null;
  error: string | null;
  hasSidecar: number;
  sidecarStatus: string;
  metadataApplied: number;
  metadataConflict: number;
  appliedFields: string | null;
  unsupportedFields: string | null;
}

function toFieldList(value: string | null): MetadataFieldName[] | undefined {
  return value ? (value.split(',') as MetadataFieldName[]) : undefined;
}

function toItem(row: RawRow): BundleItem {
  return {
    hash: row.hash,
    archiveName: row.archiveName,
    entryPath: row.entryPath,
    mediaKind: row.mediaKind as MediaKind,
    state: row.state as BundleItemState,
    hasSidecar: row.hasSidecar === 1,
    sidecarStatus: (row.sidecarStatus ?? 'missing') as SidecarStatus,
    metadataApplied: row.metadataApplied === 1,
    metadataConflict: row.metadataConflict === 1,
    appliedFields: toFieldList(row.appliedFields),
    unsupportedFields: toFieldList(row.unsupportedFields),
    finalPath: row.finalPath ?? undefined,
    canonicalHash: row.canonicalHash ?? undefined,
    error: row.error ?? undefined
  };
}
