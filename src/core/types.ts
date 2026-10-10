/**
 * Shared contracts between modules. Keep this file dependency-free so it can be
 * imported from the main thread, workers and node unit tests alike.
 */

/** Random-access byte source. Implementations must not read more than asked. */
export interface Reader {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type FileKind =
  | 'raw'
  | 'jpeg'
  | 'heic'
  | 'avif'
  | 'webp'
  | 'png'
  | 'gif'
  | 'tiff'
  | 'jxl'
  | 'video'
  | 'xmp'
  | 'other';

/** Normalised capture metadata. All fields optional: parsers fill what they find. */
export interface ExifInfo {
  make?: string;
  model?: string;
  lens?: string;
  iso?: number;
  /** seconds, e.g. 0.004 */
  exposureTime?: number;
  fNumber?: number;
  /** mm */
  focalLength?: number;
  /** EXIF orientation 1..8 */
  orientation?: number;
  /**
   * DateTimeOriginal (+SubSecTimeOriginal) as milliseconds, interpreting the
   * wall-clock value as if it were UTC (EXIF usually carries no zone). Only used
   * for sorting / burst detection.
   */
  captureTime?: number;
  /** Full sensor/image dimensions (not the preview's). */
  width?: number;
  height?: number;
  /** Existing in-file XMP rating (-1..5), if present. */
  rating?: number;
}

export type EmbeddedRole = 'thumb' | 'preview' | 'full';

/** A JPEG (or other natively decodable) image stored inside a container. */
export interface EmbeddedImage {
  offset: number;
  length: number;
  mime: 'image/jpeg';
  width?: number;
  height?: number;
  role: EmbeddedRole;
}

export interface ParsedFile {
  /** Container/format label, e.g. 'CR3', 'NEF', 'JPEG', 'HEIC'. */
  format: string;
  kind: FileKind;
  exif: ExifInfo;
  /** Embedded images, any order. Consumers pick by size/role. */
  images: EmbeddedImage[];
}

export type Flag = -1 | 0 | 1;
export type ColorLabel = '' | 'red' | 'yellow' | 'green' | 'blue' | 'purple';

export interface Marks {
  rating: number; // 0..5
  flag: Flag; // 1 pick, -1 reject, 0 none
  label: ColorLabel;
}

export function blobReader(blob: Blob): Reader {
  return {
    size: blob.size,
    async read(offset, length) {
      const end = Math.min(blob.size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      return new Uint8Array(await blob.slice(offset, end).arrayBuffer());
    },
  };
}

export function bytesReader(bytes: Uint8Array): Reader {
  return {
    size: bytes.byteLength,
    async read(offset, length) {
      return bytes.subarray(offset, Math.min(bytes.byteLength, offset + length));
    },
  };
}
