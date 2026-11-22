import type { ArchiveEntry, NodeId, PgnaDiagnostic } from "./types.js";

export const ZIP_METHOD_STORE = 0 as const;
export const ZIP_METHOD_DEFLATE = 8 as const;

const NODE_ID_PATTERN = /^g\d+(?:\/\d+(?:\.\d+)*)?$/;
const CLIP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validates archive-relative POSIX path safety per PGNA v1.0 §2.1.
 */
export function isSafeArchivePath(entryPath: string): boolean {
  if (!entryPath || entryPath.length === 0) return false;
  if (entryPath.includes("\\") || entryPath.includes("\0")) return false;
  if (entryPath.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(entryPath)) return false;

  const segments = entryPath.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      return false;
    }
  }
  return true;
}

export function isValidNodeId(value: string): value is NodeId {
  return NODE_ID_PATTERN.test(value);
}

export function isValidClipId(clipId: string): boolean {
  return clipId !== "timeline" && CLIP_ID_PATTERN.test(clipId);
}

export interface ValidationResult {
  valid: boolean;
  diagnostics: PgnaDiagnostic[];
}

/**
 * Validates archive-level path safety and audio STORE (method 0) invariants.
 * Full re-compilation staleness check (`STALE_TIMELINE`) will live in the reference implementation.
 */
export function validatePgnaArchive(
  entries: readonly ArchiveEntry[],
  audioPaths: ReadonlySet<string> = new Set(),
): ValidationResult {
  const diagnostics: PgnaDiagnostic[] = [];

  for (const entry of entries) {
    if (!isSafeArchivePath(entry.path)) {
      diagnostics.push({
        code: "UNSAFE_ARCHIVE_PATH",
        severity: "error",
        path: entry.path,
        message: `Archive path "${entry.path}" violates PGNA v1.0 §2.1 POSIX safety rules.`,
      });
    }

    if (audioPaths.has(entry.path) && entry.compressionMethod !== ZIP_METHOD_STORE) {
      diagnostics.push({
        code: "AUDIO_NOT_STORED",
        severity: "error",
        path: entry.path,
        message: `Audio clip "${entry.path}" MUST use ZIP STORE (method 0), found method ${entry.compressionMethod}.`,
      });
    }
  }

  return {
    valid: diagnostics.every((d) => d.severity !== "error"),
    diagnostics,
  };
}
