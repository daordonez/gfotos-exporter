export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png', '.tif', '.tiff', '.gif']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.3gp', '.3g2']);

export type MediaKind = 'image' | 'video';
export type MigrationStatus = 'pending' | 'imported' | 'failed' | 'unknown' | 'skipped';

export interface MediaCandidate {
  archivePath: string;
  entryPath: string;
  size: number;
  kind: MediaKind;
  sidecarPath?: string;
}

export interface TakeoutInventory {
  archives: number;
  images: number;
  videos: number;
  compressedBytes: number;
  extractBytes: number;
  rejectedEntries: number;
}

export interface TakeoutMetadata {
  takenAt?: Date;
  title?: string;
}

export interface MigrationPaths {
  volumePath: string;
  libraryPath: string;
  workPath: string;
  databasePath: string;
  reportPath: string;
}

export interface MigrationItem {
  hash: string;
  archivePath: string;
  entryPath: string;
  mediaKind: MediaKind;
  status: MigrationStatus;
  error?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}
