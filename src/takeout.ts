import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {mkdir, readdir, readFile, stat, unlink} from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import yauzl from 'yauzl';
import type {MediaCandidate, MediaKind, TakeoutInventory, TakeoutMetadata} from './domain.js';
import {IMAGE_EXTENSIONS, VIDEO_EXTENSIONS} from './domain.js';
import {isSafeArchivePath} from './system.js';

const MAX_ENTRY_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 250_000;

interface ZipEntry {
  fileName: string;
  uncompressedSize: number;
  compressedSize: number;
  directory: boolean;
}

function openZip(archivePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => yauzl.open(archivePath, {lazyEntries: true, decodeStrings: true, validateEntrySizes: true}, (error, zip) => error || !zip ? reject(error ?? new Error('Unable to open archive.')) : resolve(zip)));
}

async function entriesFor(archivePath: string): Promise<ZipEntry[]> {
  const zip = await openZip(archivePath);
  return new Promise((resolve, reject) => {
    const entries: ZipEntry[] = [];
    zip.on('entry', entry => {
      if (entries.length >= MAX_ARCHIVE_ENTRIES) {
        zip.close();
        reject(new Error(`Archive exceeds the ${MAX_ARCHIVE_ENTRIES} entry safety limit.`));
        return;
      }
      entries.push({fileName: entry.fileName, uncompressedSize: entry.uncompressedSize, compressedSize: entry.compressedSize, directory: /\/$/.test(entry.fileName)});
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', reject);
    zip.readEntry();
  });
}

function kindFor(entryPath: string): MediaKind | undefined {
  const extension = path.extname(entryPath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  return undefined;
}

export async function listTakeoutArchives(sourcePath: string): Promise<string[]> {
  const source = path.resolve(sourcePath);
  const sourceStats = await stat(source);
  if (sourceStats.isFile()) {
    if (!source.toLowerCase().endsWith('.zip')) throw new Error('The source file must be a ZIP archive.');
    return [source];
  }
  const discovered: string[] = [];
  const visit = async (target: string): Promise<void> => {
    const entries = await readdir(target, {withFileTypes: true});
    for (const entry of entries) {
      const child = path.join(target, entry.name);
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) discovered.push(child);
    }
  };
  await visit(source);
  return discovered.sort();
}

export async function inventoryTakeout(sourcePath: string): Promise<{inventory: TakeoutInventory; media: MediaCandidate[]}> {
  const archives = await listTakeoutArchives(sourcePath);
  const inventory: TakeoutInventory = {archives: archives.length, images: 0, videos: 0, compressedBytes: 0, extractBytes: 0, rejectedEntries: 0};
  const media: MediaCandidate[] = [];
  for (const archivePath of archives) {
    const entries = await entriesFor(archivePath);
    const names = new Set(entries.map(entry => entry.fileName));
    for (const entry of entries) {
      inventory.compressedBytes += entry.compressedSize;
      const kind = !entry.directory && isSafeArchivePath(entry.fileName) && entry.uncompressedSize <= MAX_ENTRY_BYTES ? kindFor(entry.fileName) : undefined;
      if (!kind) {
        if (!entry.directory && (kindFor(entry.fileName) || !isSafeArchivePath(entry.fileName))) inventory.rejectedEntries++;
        continue;
      }
      const sidecarPath = names.has(`${entry.fileName}.json`) ? `${entry.fileName}.json` : undefined;
      media.push({archivePath, entryPath: entry.fileName, size: entry.uncompressedSize, kind, sidecarPath});
      inventory.extractBytes += entry.uncompressedSize;
      if (kind === 'image') inventory.images++;
      else inventory.videos++;
    }
  }
  return {inventory, media};
}

export async function extractEntry(archivePath: string, entryPath: string, destinationPath: string): Promise<void> {
  if (!isSafeArchivePath(entryPath)) throw new Error('Unsafe archive entry path.');
  const zip = await openZip(archivePath);
  await mkdir(path.dirname(destinationPath), {recursive: true, mode: 0o700});
  return new Promise((resolve, reject) => {
    zip.on('entry', entry => {
      if (entry.fileName !== entryPath) {
        zip.readEntry();
        return;
      }
      if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
        zip.close();
        reject(new Error('Archive entry exceeds the extraction safety limit.'));
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new Error('Unable to read archive entry.'));
          return;
        }
        void pipeline(stream, createWriteStream(destinationPath, {mode: 0o600}))
          .then(() => {
            zip.close();
            resolve();
          })
          .catch(reject);
      });
    });
    zip.once('end', () => reject(new Error(`Archive entry not found: ${entryPath}`)));
    zip.once('error', reject);
    zip.readEntry();
  });
}

export async function sha256File(target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(target);
    stream.once('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

export async function readTakeoutMetadata(jsonPath: string | undefined): Promise<TakeoutMetadata> {
  if (!jsonPath) return {};
  try {
    const data = JSON.parse(await readFile(jsonPath, 'utf8')) as Record<string, unknown>;
    const taken = data.photoTakenTime as {timestamp?: string} | undefined;
    const created = data.creationTime as {timestamp?: string} | undefined;
    const timestamp = taken?.timestamp ?? created?.timestamp;
    const seconds = timestamp ? Number(timestamp) : Number.NaN;
    return {takenAt: Number.isFinite(seconds) ? new Date(seconds * 1000) : undefined, title: typeof data.title === 'string' ? data.title : undefined};
  } catch {
    return {};
  }
}

export async function removeIfExists(target: string): Promise<void> {
  await unlink(target).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}
