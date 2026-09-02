import {run} from './system.js';
import type {MediaKind, MetadataField, MetadataFieldStatuses, TakeoutMetadata} from './domain.js';

function exifDate(date: Date): string {
  return date.toISOString().replace(/[-T]/g, ':').replace(/\.\d{3}Z$/, '+00:00');
}

/** Fields present in the supplied metadata, in the order they should be considered for status reporting. */
function presentFields(metadata: TakeoutMetadata): MetadataField[] {
  const fields: MetadataField[] = [];
  if (metadata.takenAt) fields.push('takenAt');
  if (metadata.title !== undefined) fields.push('title');
  if (metadata.description !== undefined) fields.push('description');
  if (metadata.latitude !== undefined && metadata.longitude !== undefined) {
    fields.push('latitude', 'longitude');
    if (metadata.altitude !== undefined) fields.push('altitude');
  }
  return fields;
}

function buildArguments(kind: MediaKind, metadata: TakeoutMetadata): string[] {
  const args: string[] = [];
  if (metadata.takenAt) {
    const date = exifDate(metadata.takenAt);
    args.push(...(kind === 'video'
      ? [`-CreateDate=${date}`, `-ModifyDate=${date}`, `-MediaCreateDate=${date}`, `-TrackCreateDate=${date}`]
      : [`-DateTimeOriginal=${date}`, `-CreateDate=${date}`, `-ModifyDate=${date}`, '-OffsetTimeOriginal=+00:00']));
  }
  if (metadata.title !== undefined) args.push(`-Title=${metadata.title}`);
  if (metadata.description !== undefined) args.push(`-Description=${metadata.description}`, `-ImageDescription=${metadata.description}`);
  if (metadata.latitude !== undefined && metadata.longitude !== undefined) {
    args.push(
      `-GPSLatitude=${metadata.latitude}`,
      `-GPSLatitudeRef=${metadata.latitude >= 0 ? 'N' : 'S'}`,
      `-GPSLongitude=${metadata.longitude}`,
      `-GPSLongitudeRef=${metadata.longitude >= 0 ? 'E' : 'W'}`
    );
    if (metadata.altitude !== undefined) {
      args.push(`-GPSAltitude=${Math.abs(metadata.altitude)}`, `-GPSAltitudeRef=${metadata.altitude < 0 ? 1 : 0}`);
    }
  }
  return args;
}

interface ReadBack {
  GPSLatitude?: number;
  GPSLongitude?: number;
  GPSAltitude?: number;
  Title?: string;
  Description?: string;
  DateTimeOriginal?: string;
  CreateDate?: string;
}

const COORDINATE_TOLERANCE = 0.0001;
const ALTITUDE_TOLERANCE = 0.5;

async function readBack(filePath: string): Promise<ReadBack | undefined> {
  try {
    const result = await run('/usr/bin/env', [
      'exiftool', '-j', '-n', '-GPSLatitude', '-GPSLongitude', '-GPSAltitude', '-Title', '-Description', '-DateTimeOriginal', '-CreateDate', filePath
    ]);
    const parsed = JSON.parse(result.stdout) as ReadBack[];
    return parsed[0];
  } catch {
    return undefined;
  }
}

/**
 * Writes capture date, GPS, title, and description fields into the output media file via ExifTool,
 * then reads the file back to verify which fields were actually embedded. Fields that ExifTool
 * cannot write for a given format (e.g. GPS on some legacy formats) are reported as 'unsupported'
 * rather than causing the whole item to fail. Never throws: a missing or broken ExifTool binary
 * degrades every present field to 'unsupported' so the caller can keep processing other items.
 */
export async function applyTakeoutMetadata(filePath: string, kind: MediaKind, metadata: TakeoutMetadata): Promise<MetadataFieldStatuses> {
  const fields = presentFields(metadata);
  const statuses: MetadataFieldStatuses = {};
  if (fields.length === 0) return statuses;

  const args = buildArguments(kind, metadata);
  try {
    await run('/usr/bin/env', ['exiftool', '-overwrite_original', '-api', 'QuickTimeUTC=1', ...args, filePath]);
  } catch {
    for (const field of fields) statuses[field] = 'unsupported';
    return statuses;
  }

  const readBackResult = await readBack(filePath);
  if (!readBackResult) {
    for (const field of fields) statuses[field] = 'unsupported';
    return statuses;
  }

  for (const field of fields) statuses[field] = fieldApplied(field, metadata, readBackResult) ? 'applied' : 'unsupported';
  return statuses;
}

function fieldApplied(field: MetadataField, metadata: TakeoutMetadata, readBackResult: ReadBack): boolean {
  switch (field) {
    case 'takenAt': {
      if (!metadata.takenAt) return false;
      const iso = metadata.takenAt.toISOString();
      const expectedCanonical = `${iso.slice(0, 10).replaceAll('-', ':')} ${iso.slice(11, 19)}`;
      const actual = readBackResult.DateTimeOriginal ?? readBackResult.CreateDate;
      return actual !== undefined && actual.startsWith(expectedCanonical);
    }
    case 'title':
      return metadata.title !== undefined && readBackResult.Title === metadata.title;
    case 'description':
      return metadata.description !== undefined && readBackResult.Description === metadata.description;
    case 'latitude':
      return metadata.latitude !== undefined && readBackResult.GPSLatitude !== undefined && Math.abs(readBackResult.GPSLatitude - metadata.latitude) < COORDINATE_TOLERANCE;
    case 'longitude':
      return metadata.longitude !== undefined && readBackResult.GPSLongitude !== undefined && Math.abs(readBackResult.GPSLongitude - metadata.longitude) < COORDINATE_TOLERANCE;
    case 'altitude':
      return metadata.altitude !== undefined && readBackResult.GPSAltitude !== undefined && Math.abs(readBackResult.GPSAltitude - metadata.altitude) < ALTITUDE_TOLERANCE;
    default:
      return false;
  }
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
