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
  /** SHA-256 of the final bytes actually written to `import/` after any metadata enrichment; distinct from `hash`, which is the source fingerprint used for deduplication. */
  finalHash?: string;
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
  metadataCounts?: MetadataCounts;
}

export interface MetadataCounts {
  present: number;
  applied: number;
  unsupported: number;
  missing: number;
  invalid: number;
  conflicting: number;
}

/** Per-field status of a single metadata field for a single bundle item. */
export type MetadataFieldStatus = 'present' | 'applied' | 'unsupported' | 'missing' | 'invalid';

export const METADATA_FIELDS = ['takenAt', 'title', 'description', 'latitude', 'longitude', 'altitude'] as const;
export type MetadataField = (typeof METADATA_FIELDS)[number];

/** Per-item, per-field status record produced while applying metadata to output media. */
export type MetadataFieldStatuses = Partial<Record<MetadataField, MetadataFieldStatus>>;

/** A single conflicting sidecar value observed for a field on an already-canonical hash. */
export interface MetadataConflictValue {
  value: string;
  sourceArchive: string;
  sourceEntry: string;
}

export interface MetadataConflict {
  hash: string;
  field: MetadataField;
  values: MetadataConflictValue[];
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
  /** Which sidecar field the takenAt value was derived from, for reporting purposes. */
  takenAtSource?: 'photoTakenTime' | 'creationTime';
  title?: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
}

/** Returns a stable string representation of a metadata field's value, or undefined if absent. */
export function metadataFieldValue(metadata: TakeoutMetadata, field: MetadataField): string | undefined {
  switch (field) {
    case 'takenAt':
      return metadata.takenAt?.toISOString();
    case 'title':
      return metadata.title;
    case 'description':
      return metadata.description;
    case 'latitude':
      return metadata.latitude !== undefined ? String(metadata.latitude) : undefined;
    case 'longitude':
      return metadata.longitude !== undefined ? String(metadata.longitude) : undefined;
    case 'altitude':
      return metadata.altitude !== undefined ? String(metadata.altitude) : undefined;
    default:
      return undefined;
  }
}

export function metadataHasField(metadata: TakeoutMetadata, field: MetadataField): boolean {
  return metadataFieldValue(metadata, field) !== undefined;
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
