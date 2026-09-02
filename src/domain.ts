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

/** Result of attempting to locate and parse a Takeout sidecar JSON file. */
export type SidecarStatus = 'present' | 'missing' | 'invalid';

/** Named metadata fields that can be embedded into media via ExifTool. */
export type MetadataFieldName = 'date' | 'title' | 'description' | 'gps';

export interface BundleItem {
  hash: string;
  archiveName: string;
  entryPath: string;
  mediaKind: MediaKind;
  state: BundleItemState;
  hasSidecar: boolean;
  /** Whether the sidecar JSON (if any) was found and parsed successfully. */
  sidecarStatus: SidecarStatus;
  /** True when at least one metadata field was written into the materialized file via ExifTool. */
  metadataApplied: boolean;
  /** True when this hash has divergent sidecar values across duplicate copies. */
  metadataConflict: boolean;
  /** Fields successfully embedded into the media file. */
  appliedFields?: MetadataFieldName[];
  /** Fields present in the sidecar but not embeddable for this file's kind/format. */
  unsupportedFields?: MetadataFieldName[];
  finalPath?: string;
  canonicalHash?: string;
  error?: string;
}

export interface MetadataConflictEntry {
  hash: string;
  field: MetadataFieldName;
  canonicalArchiveName: string;
  canonicalEntryPath: string;
  canonicalValue: string;
  conflictingArchiveName: string;
  conflictingEntryPath: string;
  conflictingValue: string;
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
    metadataApplied: number;
    metadataPresent: number;
    metadataMissing: number;
    metadataInvalid: number;
    metadataConflicting: number;
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
  description?: string;
  /** GPS coordinates, preferring Takeout's `geoData` over `geoDataExif` when both are present. */
  latitude?: number;
  longitude?: number;
  altitude?: number;
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
