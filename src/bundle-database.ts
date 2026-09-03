import type {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {ensureDirectory} from './system.js';
import type {BundleItem, BundleItemState, MediaKind, MetadataConflict, MetadataConflictValue, MetadataCounts, MetadataField, MetadataFieldStatuses, TakeoutMetadata} from './domain.js';
import {METADATA_FIELDS} from './domain.js';

export interface ItemMetadataRecord {
  hash: string;
  sidecarState: 'present' | 'missing' | 'invalid';
  metadata: TakeoutMetadata;
  fieldStatuses: MetadataFieldStatuses;
  sourceArchive: string;
  sourceEntry: string;
}

export class BundleDatabase {
  private readonly database: DatabaseSync;
  private readonly itemSelect: string;

  static async open(databasePath: string, options: {readOnly?: boolean} = {}): Promise<BundleDatabase> {
    if (!options.readOnly) await ensureDirectory(path.dirname(databasePath));
    const {DatabaseSync} = await import('node:sqlite');
    return new BundleDatabase(new DatabaseSync(databasePath, options.readOnly ? {readOnly: true} : {}), options.readOnly ?? false);
  }

  private constructor(database: DatabaseSync, readOnly: boolean) {
    this.database = database;
    if (readOnly) {
      const columns = this.database.prepare('PRAGMA table_info(bundle_items)').all() as Array<{name: string}>;
      this.itemSelect = columns.some(column => column.name === 'final_hash')
        ? 'final_hash AS finalHash'
        : 'NULL AS finalHash';
      return;
    }
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
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (archive_name, entry_path)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS bundle_items_hash ON bundle_items(hash);

      CREATE TABLE IF NOT EXISTS item_metadata (
        hash TEXT PRIMARY KEY,
        sidecar_state TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        field_statuses_json TEXT NOT NULL,
        source_archive TEXT NOT NULL,
        source_entry TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;

      CREATE TABLE IF NOT EXISTS metadata_conflicts (
        hash TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT,
        source_archive TEXT NOT NULL,
        source_entry TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (hash, field, source_archive, source_entry)
      ) STRICT;
    `);

    // CREATE TABLE IF NOT EXISTS does not add columns to an already-existing database file,
    // so migrate bundle databases created before the final-output hash field was introduced.
    const columns = this.database.prepare('PRAGMA table_info(bundle_items)').all() as Array<{name: string}>;
    if (!columns.some(column => column.name === 'final_hash')) {
      this.database.exec('ALTER TABLE bundle_items ADD COLUMN final_hash TEXT');
    }
    this.itemSelect = 'final_hash AS finalHash';
  }

  find(hash: string): BundleItem | undefined {
    const row = this.database
      .prepare(`SELECT hash, archive_name AS archiveName, entry_path AS entryPath, media_kind AS mediaKind, state, final_path AS finalPath, canonical_hash AS canonicalHash, error, has_sidecar AS hasSidecar, ${this.itemSelect} FROM bundle_items WHERE hash = ? AND state = 'materialized' LIMIT 1`)
      .get(hash) as RawRow | undefined;
    return row ? toItem(row) : undefined;
  }

  findByEntry(archiveName: string, entryPath: string): BundleItem | undefined {
    const row = this.database
      .prepare(`SELECT hash, archive_name AS archiveName, entry_path AS entryPath, media_kind AS mediaKind, state, final_path AS finalPath, canonical_hash AS canonicalHash, error, has_sidecar AS hasSidecar, ${this.itemSelect} FROM bundle_items WHERE archive_name = ? AND entry_path = ?`)
      .get(archiveName, entryPath) as RawRow | undefined;
    return row ? toItem(row) : undefined;
  }

  save(item: BundleItem): void {
    this.database.prepare(`
      INSERT INTO bundle_items (hash, archive_name, entry_path, media_kind, state, final_path, canonical_hash, error, has_sidecar, final_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(archive_name, entry_path) DO UPDATE SET
        hash = excluded.hash,
        state = excluded.state,
        final_path = excluded.final_path,
        canonical_hash = excluded.canonical_hash,
        error = excluded.error,
        has_sidecar = excluded.has_sidecar,
        final_hash = excluded.final_hash,
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
      item.finalHash ?? null
    );
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

  listItems(): BundleItem[] {
    return (this.database
      .prepare(`SELECT hash, archive_name AS archiveName, entry_path AS entryPath, media_kind AS mediaKind, state, final_path AS finalPath, canonical_hash AS canonicalHash, error, has_sidecar AS hasSidecar, ${this.itemSelect} FROM bundle_items ORDER BY updated_at ASC`)
      .all() as unknown as RawRow[]).map(toItem);
  }

  saveItemMetadata(record: ItemMetadataRecord): void {
    this.database.prepare(`
      INSERT INTO item_metadata (hash, sidecar_state, metadata_json, field_statuses_json, source_archive, source_entry)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET
        sidecar_state = excluded.sidecar_state,
        metadata_json = excluded.metadata_json,
        field_statuses_json = excluded.field_statuses_json,
        source_archive = excluded.source_archive,
        source_entry = excluded.source_entry,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      record.hash,
      record.sidecarState,
      JSON.stringify(serializeMetadata(record.metadata)),
      JSON.stringify(record.fieldStatuses),
      record.sourceArchive,
      record.sourceEntry
    );
  }

  getItemMetadata(hash: string): ItemMetadataRecord | undefined {
    const row = this.database
      .prepare('SELECT hash, sidecar_state AS sidecarState, metadata_json AS metadataJson, field_statuses_json AS fieldStatusesJson, source_archive AS sourceArchive, source_entry AS sourceEntry FROM item_metadata WHERE hash = ?')
      .get(hash) as RawMetadataRow | undefined;
    return row ? toMetadataRecord(row) : undefined;
  }

  updateItemMetadataStatuses(hash: string, fieldStatuses: MetadataFieldStatuses): void {
    this.database.prepare('UPDATE item_metadata SET field_statuses_json = ?, updated_at = CURRENT_TIMESTAMP WHERE hash = ?')
      .run(JSON.stringify(fieldStatuses), hash);
  }

  recordConflict(hash: string, field: MetadataField, value: string | undefined, sourceArchive: string, sourceEntry: string): void {
    this.database
      .prepare('INSERT OR IGNORE INTO metadata_conflicts (hash, field, value, source_archive, source_entry) VALUES (?, ?, ?, ?, ?)')
      .run(hash, field, value ?? null, sourceArchive, sourceEntry);
  }

  listConflicts(): MetadataConflict[] {
    const rows = this.database
      .prepare('SELECT hash, field, value, source_archive AS sourceArchive, source_entry AS sourceEntry FROM metadata_conflicts ORDER BY hash, field, created_at')
      .all() as Array<{hash: string; field: MetadataField; value: string | null; sourceArchive: string; sourceEntry: string}>;
    const grouped = new Map<string, MetadataConflict>();
    for (const row of rows) {
      const key = `${row.hash}:${row.field}`;
      const value: MetadataConflictValue = {value: row.value ?? '(none)', sourceArchive: row.sourceArchive, sourceEntry: row.sourceEntry};
      const existing = grouped.get(key);
      if (existing) existing.values.push(value);
      else grouped.set(key, {hash: row.hash, field: row.field, values: [value]});
    }
    return [...grouped.values()];
  }

  countMetadata(): MetadataCounts {
    const counts: MetadataCounts = {present: 0, applied: 0, unsupported: 0, missing: 0, invalid: 0, conflicting: 0};
    const rows = this.database.prepare('SELECT field_statuses_json AS fieldStatusesJson FROM item_metadata').all() as Array<{fieldStatusesJson: string}>;
    for (const row of rows) {
      const statuses = JSON.parse(row.fieldStatusesJson) as MetadataFieldStatuses;
      for (const field of METADATA_FIELDS) {
        const status = statuses[field];
        if (status === 'applied') { counts.applied++; counts.present++; }
        else if (status === 'present') counts.present++;
        else if (status === 'unsupported') { counts.unsupported++; counts.present++; }
        else if (status === 'missing') counts.missing++;
        else if (status === 'invalid') counts.invalid++;
      }
    }
    const conflictRow = this.database.prepare('SELECT COUNT(DISTINCT hash || \':\' || field) AS count FROM metadata_conflicts').get() as {count: number};
    counts.conflicting = conflictRow.count;
    return counts;
  }

  close(): void {
    this.database.close();
  }
}

function serializeMetadata(metadata: TakeoutMetadata): Record<string, unknown> {
  return {
    takenAt: metadata.takenAt?.toISOString(),
    takenAtSource: metadata.takenAtSource,
    title: metadata.title,
    description: metadata.description,
    latitude: metadata.latitude,
    longitude: metadata.longitude,
    altitude: metadata.altitude
  };
}

function deserializeMetadata(raw: Record<string, unknown>): TakeoutMetadata {
  return {
    takenAt: typeof raw.takenAt === 'string' ? new Date(raw.takenAt) : undefined,
    takenAtSource: raw.takenAtSource as TakeoutMetadata['takenAtSource'],
    title: typeof raw.title === 'string' ? raw.title : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    latitude: typeof raw.latitude === 'number' ? raw.latitude : undefined,
    longitude: typeof raw.longitude === 'number' ? raw.longitude : undefined,
    altitude: typeof raw.altitude === 'number' ? raw.altitude : undefined
  };
}

interface RawMetadataRow {
  hash: string;
  sidecarState: string;
  metadataJson: string;
  fieldStatusesJson: string;
  sourceArchive: string;
  sourceEntry: string;
}

function toMetadataRecord(row: RawMetadataRow): ItemMetadataRecord {
  return {
    hash: row.hash,
    sidecarState: row.sidecarState as ItemMetadataRecord['sidecarState'],
    metadata: deserializeMetadata(JSON.parse(row.metadataJson) as Record<string, unknown>),
    fieldStatuses: JSON.parse(row.fieldStatusesJson) as MetadataFieldStatuses,
    sourceArchive: row.sourceArchive,
    sourceEntry: row.sourceEntry
  };
}

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
  finalHash: string | null;
}

function toItem(row: RawRow): BundleItem {
  return {
    hash: row.hash,
    archiveName: row.archiveName,
    entryPath: row.entryPath,
    mediaKind: row.mediaKind as MediaKind,
    state: row.state as BundleItemState,
    hasSidecar: row.hasSidecar === 1,
    finalPath: row.finalPath ?? undefined,
    canonicalHash: row.canonicalHash ?? undefined,
    error: row.error ?? undefined,
    finalHash: row.finalHash ?? undefined
  };
}
