import type {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {ensureDirectory} from './system.js';
import type {BundleItem, BundleItemState, MediaKind} from './domain.js';

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
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (archive_name, entry_path)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS bundle_items_hash ON bundle_items(hash);
    `);
  }

  find(hash: string): BundleItem | undefined {
    const row = this.database
      .prepare("SELECT hash, archive_name AS archiveName, entry_path AS entryPath, media_kind AS mediaKind, state, final_path AS finalPath, canonical_hash AS canonicalHash, error, has_sidecar AS hasSidecar FROM bundle_items WHERE hash = ? AND state = 'materialized' LIMIT 1")
      .get(hash) as RawRow | undefined;
    return row ? toItem(row) : undefined;
  }

  findByEntry(archiveName: string, entryPath: string): BundleItem | undefined {
    const row = this.database
      .prepare('SELECT hash, archive_name AS archiveName, entry_path AS entryPath, media_kind AS mediaKind, state, final_path AS finalPath, canonical_hash AS canonicalHash, error, has_sidecar AS hasSidecar FROM bundle_items WHERE archive_name = ? AND entry_path = ?')
      .get(archiveName, entryPath) as RawRow | undefined;
    return row ? toItem(row) : undefined;
  }

  save(item: BundleItem): void {
    this.database.prepare(`
      INSERT INTO bundle_items (hash, archive_name, entry_path, media_kind, state, final_path, canonical_hash, error, has_sidecar)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(archive_name, entry_path) DO UPDATE SET
        hash = excluded.hash,
        state = excluded.state,
        final_path = excluded.final_path,
        canonical_hash = excluded.canonical_hash,
        error = excluded.error,
        has_sidecar = excluded.has_sidecar,
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
      item.hasSidecar ? 1 : 0
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
      .prepare('SELECT hash, archive_name AS archiveName, entry_path AS entryPath, media_kind AS mediaKind, state, final_path AS finalPath, canonical_hash AS canonicalHash, error, has_sidecar AS hasSidecar FROM bundle_items ORDER BY updated_at ASC')
      .all() as unknown as RawRow[]).map(toItem);
  }

  close(): void {
    this.database.close();
  }
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
    error: row.error ?? undefined
  };
}
