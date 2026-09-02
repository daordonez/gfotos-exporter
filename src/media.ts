import path from 'node:path';
import {run} from './system.js';
import type {MediaKind, MetadataFieldName, TakeoutMetadata} from './domain.js';

export interface ApplyMetadataResult {
  /** Fields successfully written into the media file via ExifTool. */
  applied: MetadataFieldName[];
  /** Fields present in the sidecar metadata but not embeddable for this file's format. */
  unsupported: MetadataFieldName[];
}

function exifDate(date: Date): string {
  return date.toISOString().replace(/[-T]/g, ':').replace(/\.\d{3}Z$/, '+00:00');
}

// GIF containers do not carry a usable EXIF/XMP GPS block via ExifTool's composite tags.
const GPS_UNSUPPORTED_EXTENSIONS = new Set(['.gif']);

function supportsGps(filePath: string): boolean {
  return !GPS_UNSUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function hasGps(metadata: TakeoutMetadata): metadata is TakeoutMetadata & {latitude: number; longitude: number} {
  return typeof metadata.latitude === 'number' && typeof metadata.longitude === 'number';
}

function gpsArguments(metadata: {latitude: number; longitude: number; altitude?: number}): string[] {
  const latitudeRef = metadata.latitude >= 0 ? 'N' : 'S';
  const longitudeRef = metadata.longitude >= 0 ? 'E' : 'W';
  const args = [
    `-GPSLatitude=${Math.abs(metadata.latitude)}`,
    `-GPSLatitudeRef=${latitudeRef}`,
    `-GPSLongitude=${Math.abs(metadata.longitude)}`,
    `-GPSLongitudeRef=${longitudeRef}`
  ];
  if (typeof metadata.altitude === 'number') {
    args.push(`-GPSAltitude=${Math.abs(metadata.altitude)}`, `-GPSAltitudeRef=${metadata.altitude < 0 ? 1 : 0}`);
  }
  return args;
}

/**
 * Writes Takeout-derived metadata into a materialized media file via ExifTool.
 * Returns which fields were applied vs. present-but-unsupported for this file's format.
 * Does not throw for "no metadata to write" (returns empty arrays and skips invoking
 * ExifTool entirely). Callers should treat ExifTool execution failures (e.g. missing
 * binary) as non-fatal for the overall migration.
 */
export async function applyTakeoutMetadata(filePath: string, kind: MediaKind, metadata: TakeoutMetadata): Promise<ApplyMetadataResult> {
  const applied: MetadataFieldName[] = [];
  const unsupported: MetadataFieldName[] = [];
  const args: string[] = [];

  if (metadata.takenAt) {
    const date = exifDate(metadata.takenAt);
    if (kind === 'video') args.push(`-CreateDate=${date}`, `-ModifyDate=${date}`, `-MediaCreateDate=${date}`, `-TrackCreateDate=${date}`);
    else args.push(`-DateTimeOriginal=${date}`, `-CreateDate=${date}`, `-ModifyDate=${date}`, '-OffsetTimeOriginal=+00:00');
    applied.push('date');
  }

  if (metadata.title) {
    args.push(`-Title=${metadata.title}`, `-XMP:Title=${metadata.title}`);
    applied.push('title');
  }

  if (metadata.description) {
    if (kind === 'video') args.push(`-Description=${metadata.description}`);
    else args.push(`-Description=${metadata.description}`, `-ImageDescription=${metadata.description}`, `-XMP:Description=${metadata.description}`);
    applied.push('description');
  }

  if (hasGps(metadata)) {
    if (supportsGps(filePath)) {
      args.push(...gpsArguments(metadata));
      applied.push('gps');
    } else {
      unsupported.push('gps');
    }
  }

  if (args.length === 0) return {applied, unsupported};

  await run('/usr/bin/env', ['exiftool', '-overwrite_original', '-api', 'QuickTimeUTC=1', ...args, filePath]);
  return {applied, unsupported};
}

export async function exifToolAvailable(): Promise<boolean> {
  try {
    await run('/usr/bin/env', ['exiftool', '-ver']);
    return true;
  } catch {
    return false;
  }
}

export async function installExifTool(): Promise<void> {
  await run('/usr/bin/env', ['brew', 'install', 'exiftool']);
}
