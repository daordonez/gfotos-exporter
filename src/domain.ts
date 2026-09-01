export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png', '.tif', '.tiff', '.gif']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.3gp', '.3g2']);

export type MediaKind = 'image' | 'video';
export type MigrationStatus = 'pending' | 'imported' | 'failed' | 'unknown' | 'skipped';
export type BundleItemState = 'pending' | 'materialized' | 'duplicate' | 'failed' | 'skipped';

export interface MediaCandidate {
  archivePath: string;
  entryPath: string;
  size: number;
  kind: MediaKind;
  /** Entry path of the sidecar JSON within its archive. */
  sidecarEntryPath?: string;
  /** Archive path containing the sidecar, if different from archivePath. */
  sidecarArchivePath?: string;
}

export interface BundlePaths {
  volumePath: string;
  importPath: string;
  bundlePath: string;
  databasePath: string;
  sidecarsPath: string;
  reportsPath: string;
  manifestPath: string;
}

export interface BundleItem {
  hash: string;
  archiveName: string;
  entryPath: string;
  mediaKind: MediaKind;
  state: BundleItemState;
  hasSidecar: boolean;
  finalPath?: string;
  canonicalHash?: string;
  error?: string;
}

export interface BundleManifest {
  version: number;
  createdAt: string;
  updatedAt: string;
  sourceFingerprint: string;
  counts: {
    total: number;
    materialized: number;
    duplicate: number;
    failed: number;
    skipped: number;
    pending: number;
    missingSidecar: number;
  };
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
