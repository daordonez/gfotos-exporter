import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {crc32} from 'node:zlib';
import type {MediaKind} from './domain.js';

/** Image/video extensions this module does not yet implement a content validator for. */
const UNVALIDATED_IMAGE_EXTENSIONS = new Set(['.heic', '.heif', '.tif', '.tiff', '.gif']);
const UNVALIDATED_VIDEO_EXTENSIONS = new Set(['.mov', '.m4v', '.avi', '.3gp', '.3g2']);

export type MediaContainer = 'jpeg' | 'png' | 'mp4' | 'unknown';

export interface MediaValidationResult {
  status: 'valid' | 'invalid' | 'unchecked';
  container: MediaContainer;
  reason?: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bounds for the leading-box scan used to sniff MP4/ISO-BMFF containers: cheap and safe against pathological or huge declared box sizes. */
const MP4_SNIFF_MAX_BOXES = 8;
const MP4_SNIFF_MAX_BYTES = 4096;

/**
 * Scans a bounded number of leading top-level ISO-BMFF boxes looking for a `ftyp` box, tolerating
 * padding boxes (e.g. `free`/`skip`/`wide`) that some encoders/editors emit before it. This mirrors
 * `validateMp4`'s tolerance so `detectContainer` does not misclassify a structurally valid MP4 as
 * unknown just because `ftyp` is not the literal first box. Never throws.
 */
function looksLikeMp4(buffer: Buffer): boolean {
  let offset = 0;
  for (let boxIndex = 0; boxIndex < MP4_SNIFF_MAX_BOXES && offset < buffer.length && offset < MP4_SNIFF_MAX_BYTES; boxIndex++) {
    if (offset + 8 > buffer.length) return false;
    const declaredSize = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'ftyp') return true;

    let headerSize = 8;
    let boxSize: number;
    if (declaredSize === 1) {
      if (offset + 16 > buffer.length) return false;
      boxSize = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (declaredSize === 0) {
      boxSize = buffer.length - offset;
    } else {
      boxSize = declaredSize;
    }
    if (boxSize < headerSize || boxSize <= 0) return false;
    offset += boxSize;
  }
  return false;
}

/** Sniffs the media container type from magic bytes only. Extensions are never trusted. */
export function detectContainer(buffer: Buffer): MediaContainer {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (looksLikeMp4(buffer)) return 'mp4';
  return 'unknown';
}

/**
 * Walks JPEG markers from the SOI, validating structure without decoding pixel data. Never throws:
 * any structural problem (truncation, bad marker sequence, missing EOI) yields status 'invalid'.
 */
export function validateJpeg(buffer: Buffer): MediaValidationResult {
  const container: MediaContainer = 'jpeg';
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return {status: 'invalid', container, reason: 'JPEG file does not start with a Start Of Image marker.'};
  }
  let offset = 2;
  while (true) {
    if (offset >= buffer.length) {
      return {status: 'invalid', container, reason: 'JPEG data ended unexpectedly before an End Of Image marker was found.'};
    }
    if (buffer[offset] !== 0xff) {
      return {status: 'invalid', container, reason: `Expected a marker at offset ${offset} but found a non-marker byte.`};
    }
    // Skip any fill bytes (0xFF padding) preceding a marker.
    let markerOffset = offset;
    while (markerOffset < buffer.length && buffer[markerOffset] === 0xff) markerOffset++;
    if (markerOffset >= buffer.length) {
      return {status: 'invalid', container, reason: 'JPEG data ended unexpectedly while scanning for a marker code.'};
    }
    const marker = buffer[markerOffset];
    offset = markerOffset + 1;

    if (marker === 0xd9) return {status: 'valid', container}; // EOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // TEM / restart markers: no payload

    if (offset + 2 > buffer.length) {
      return {status: 'invalid', container, reason: 'JPEG segment length field was truncated.'};
    }
    const length = buffer.readUInt16BE(offset);
    if (length < 2) {
      return {status: 'invalid', container, reason: 'JPEG segment declared an invalid (too small) length.'};
    }
    if (offset + length > buffer.length) {
      return {status: 'invalid', container, reason: 'JPEG segment length extends past the end of the file.'};
    }

    if (marker === 0xda) {
      // Start Of Scan: header consumed above; now scan entropy-coded data for the next real marker.
      let scan = offset + length;
      while (true) {
        if (scan + 1 >= buffer.length) {
          return {status: 'invalid', container, reason: 'JPEG scan data ended unexpectedly before an End Of Image marker was found.'};
        }
        if (buffer[scan] === 0xff) {
          const next = buffer[scan + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            scan += 2; // byte-stuffing or restart marker: part of entropy-coded data
            continue;
          }
          offset = scan;
          break;
        }
        scan++;
      }
      continue;
    }

    offset += length;
  }
}

/**
 * Walks PNG chunks, verifying the signature, per-chunk CRC32, and the presence of IHDR/IEND.
 * Does not decompress IDAT data. Never throws.
 */
export function validatePng(buffer: Buffer): MediaValidationResult {
  const container: MediaContainer = 'png';
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return {status: 'invalid', container, reason: 'PNG file does not start with the expected signature.'};
  }
  let offset = 8;
  let sawIhdr = false;
  let sawIend = false;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      return {status: 'invalid', container, reason: 'PNG chunk header was truncated.'};
    }
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcEnd = dataEnd + 4;
    if (crcEnd > buffer.length) {
      return {status: 'invalid', container, reason: `PNG chunk '${type}' extends past the end of the file.`};
    }
    const expectedCrc = crc32(buffer.subarray(offset + 4, dataEnd));
    const storedCrc = buffer.readUInt32BE(dataEnd);
    if (expectedCrc !== storedCrc) {
      return {status: 'invalid', container, reason: `PNG chunk '${type}' failed its CRC32 check.`};
    }
    if (type === 'IHDR') sawIhdr = true;
    if (type === 'IEND') { sawIend = true; offset = crcEnd; break; }
    offset = crcEnd;
  }
  if (!sawIhdr) return {status: 'invalid', container, reason: 'PNG file is missing its IHDR chunk.'};
  if (!sawIend) return {status: 'invalid', container, reason: 'PNG file is missing its IEND chunk.'};
  return {status: 'valid', container};
}

const MIN_BOX_HEADER_SIZE = 8;

/**
 * Walks top-level ISO-BMFF boxes, validating declared sizes stay within the buffer and that a
 * ftyp box is present. Does not inspect codec-level payload. Never throws.
 */
export function validateMp4(buffer: Buffer): MediaValidationResult {
  const container: MediaContainer = 'mp4';
  let offset = 0;
  let sawFtyp = false;
  while (offset < buffer.length) {
    if (offset + MIN_BOX_HEADER_SIZE > buffer.length) {
      return {status: 'invalid', container, reason: 'MP4 box header was truncated.'};
    }
    const declaredSize = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    let headerSize = MIN_BOX_HEADER_SIZE;
    let boxSize: number;
    if (declaredSize === 1) {
      if (offset + 16 > buffer.length) {
        return {status: 'invalid', container, reason: 'MP4 box declared a 64-bit size but the largesize field was truncated.'};
      }
      boxSize = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (declaredSize === 0) {
      boxSize = buffer.length - offset;
    } else {
      boxSize = declaredSize;
    }
    if (boxSize < headerSize || offset + boxSize > buffer.length) {
      return {status: 'invalid', container, reason: `MP4 box '${type}' declared a size that extends past the end of the file.`};
    }
    if (type === 'ftyp') sawFtyp = true;
    offset += boxSize;
  }
  if (!sawFtyp) return {status: 'invalid', container, reason: 'MP4 file is missing a required ftyp box.'};
  return {status: 'valid', container};
}

function containerFamily(container: MediaContainer): MediaKind | undefined {
  if (container === 'jpeg' || container === 'png') return 'image';
  if (container === 'mp4') return 'video';
  return undefined;
}

/**
 * Validates a media file by content, not by its file extension. Recognized containers
 * (JPEG, PNG, MP4) are structurally parsed; other formats this repository does not yet
 * implement a validator for (HEIC, TIFF, GIF, MOV, and similar) are reported as 'unchecked'
 * so they keep behaving as before, accepted by extension family. Never throws.
 */
export async function validateMediaFile(filePath: string, kind: MediaKind): Promise<MediaValidationResult> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {status: 'invalid', container: 'unknown', reason: `Could not read the file for validation: ${message}.`};
  }

  const container = detectContainer(buffer);
  if (container === 'unknown') {
    // Content sniffing cannot recognize these formats yet (e.g. HEIC/HEIF/TIFF/GIF images or
    // MOV/M4V/AVI/3GP/3G2 videos), so fall back to the extension only to distinguish an
    // expected-but-unimplemented format from actual garbage bytes misnamed as a media file.
    const extension = path.extname(filePath).toLowerCase();
    const isUnvalidatedKnownFormat = kind === 'image' ? UNVALIDATED_IMAGE_EXTENSIONS.has(extension) : UNVALIDATED_VIDEO_EXTENSIONS.has(extension);
    if (isUnvalidatedKnownFormat) return {status: 'unchecked', container};
    return {status: 'invalid', container, reason: 'File content does not match a recognized image or video container.'};
  }

  const family = containerFamily(container);
  if (family !== kind) {
    return {status: 'invalid', container, reason: 'File extension/kind does not match its detected content (extension/container mismatch).'};
  }

  if (container === 'jpeg') return validateJpeg(buffer);
  if (container === 'png') return validatePng(buffer);
  if (container === 'mp4') return validateMp4(buffer);
  return {status: 'unchecked', container};
}
