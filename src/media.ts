import {run} from './system.js';
import type {MediaKind, TakeoutMetadata} from './domain.js';

function exifDate(date: Date): string {
  return date.toISOString().replace(/[-T]/g, ':').replace(/\.\d{3}Z$/, '+00:00');
}

export async function applyTakeoutMetadata(filePath: string, kind: MediaKind, metadata: TakeoutMetadata): Promise<boolean> {
  if (!metadata.takenAt) return false;
  const date = exifDate(metadata.takenAt);
  const argumentsForKind = kind === 'video'
    ? [`-CreateDate=${date}`, `-ModifyDate=${date}`, `-MediaCreateDate=${date}`, `-TrackCreateDate=${date}`]
    : [`-DateTimeOriginal=${date}`, `-CreateDate=${date}`, `-ModifyDate=${date}`, '-OffsetTimeOriginal=+00:00'];
  await run('/usr/bin/env', ['exiftool', '-overwrite_original', '-api', 'QuickTimeUTC=1', ...argumentsForKind, filePath]);
  return true;
}

export async function exifToolAvailable(): Promise<boolean> {
  try {
    await run('/usr/bin/env', ['exiftool', '-ver']);
    return true;
  } catch {
    return false;
  }
}
