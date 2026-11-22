import type { ArchiveEntry } from "./types.js";
import { ZIP_METHOD_DEFLATE, ZIP_METHOD_STORE, isSafeArchivePath } from "./validator.js";

export interface PackPgnaOptions {
  /** Entry paths that must be stored uncompressed (method 0) — mandatory for audio clips. */
  storePaths?: ReadonlySet<string>;
}

/**
 * Resolves the required ZIP compression method per PGNA v1.0 §2:
 * STORE (0) for audio clips, DEFLATE (8) for JSON, PGN, and WebVTT.
 */
export function resolveCompressionMethod(
  entryPath: string,
  storePaths: ReadonlySet<string>,
): typeof ZIP_METHOD_STORE | typeof ZIP_METHOD_DEFLATE {
  return storePaths.has(entryPath) ? ZIP_METHOD_STORE : ZIP_METHOD_DEFLATE;
}

/**
 * Validates archive entries prior to ZIP packing.
 * Reference ZIP packer/unpacker drops in here.
 */
export function prepareArchiveEntries(
  files: ReadonlyArray<{ path: string; data: Uint8Array }>,
  options: PackPgnaOptions = {},
): ArchiveEntry[] {
  const storePaths = options.storePaths ?? new Set<string>();
  return files.map((file) => {
    if (!isSafeArchivePath(file.path)) {
      throw new Error(`Unsafe PGNA archive path: "${file.path}"`);
    }
    return {
      path: file.path,
      data: file.data,
      compressionMethod: resolveCompressionMethod(file.path, storePaths),
    };
  });
}
