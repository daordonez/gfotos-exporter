import type {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {ensureDirectory} from './system.js';
import type {MediaKind, MigrationItem, MigrationStatus} from './domain.js';

export class MigrationDatabase {
  private readonly database: DatabaseSync;

  static async open(databasePath: string): Promise<MigrationDatabase> {
    await ensureDirectory(path.dirname(databasePath));
    const {DatabaseSync} = await import('node:sqlite');
    return new MigrationDatabase(new DatabaseSync(databasePath));
  }

  private constructor(database: DatabaseSync) {
    this.database = database;
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS migration_items (
        hash TEXT PRIMARY KEY,
        archive_path TEXT NOT NULL,
        entry_path TEXT NOT NULL,
        media_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `);
  }

  find(hash: string): MigrationItem | undefined {
    return this.database.prepare('SELECT hash, archive_path AS archivePath, entry_path AS entryPath, media_kind AS mediaKind, status, error FROM migration_items WHERE hash = ?').get(hash) as MigrationItem | undefined;
  }

  save(item: Omit<MigrationItem, 'status'> & {status: MigrationStatus}): void {
    this.database.prepare(`
      INSERT INTO migration_items (hash, archive_path, entry_path, media_kind, status, error)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO UPDATE SET status = excluded.status, error = excluded.error, updated_at = CURRENT_TIMESTAMP
    `).run(item.hash, item.archivePath, item.entryPath, item.mediaKind, item.status, item.error ?? null);
  }

  countByStatus(): Record<MigrationStatus, number> {
    const counts: Record<MigrationStatus, number> = {pending: 0, imported: 0, failed: 0, unknown: 0, skipped: 0};
    for (const row of this.database.prepare('SELECT status, COUNT(*) AS count FROM migration_items GROUP BY status').all() as Array<{status: MigrationStatus; count: number}>) counts[row.status] = row.count;
    return counts;
  }

  listItems(): MigrationItem[] {
    return this.database.prepare('SELECT hash, archive_path AS archivePath, entry_path AS entryPath, media_kind AS mediaKind, status, error FROM migration_items ORDER BY updated_at ASC').all() as unknown as MigrationItem[];
  }

  close(): void {
    this.database.close();
  }
}
