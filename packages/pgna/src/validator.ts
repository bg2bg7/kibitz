import { compilePgna } from "./compiler.js";
import type {
  ArchiveEntry,
  NodeId,
  PgnaDiagnostic,
  PgnaManifest,
  PgnaTimeline,
} from "./types.js";
import { isOsMetadataPath, unpackPgnaZip, utf8Decode } from "./zip.js";

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

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonStringify(obj[k])}`).join(",")}}`;
}

function timelinesMatchIgnoringCompiledAt(a: PgnaTimeline, b: PgnaTimeline): boolean {
  const normA = { ...a, compiledAt: "" };
  const normB = { ...b, compiledAt: "" };
  return stableJsonStringify(normA) === stableJsonStringify(normB);
}

/**
 * Validates archive-level path safety and audio STORE (method 0) invariants.
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

/**
 * Performs full PGNA v1.0 package validation:
 * - POSIX archive path safety (§2.1)
 * - Required entries (`manifest.json`, `pgnPath`, `timelinePath`)
 * - Audio clips present & compressed with ZIP STORE method 0 (§2)
 * - Re-compiles `manifest` + PGN + per-clip subtitles and rejects stale/divergent `timeline.json`
 *   (ignoring `compiledAt`) with `STALE_TIMELINE` (§6).
 */
export function validatePgnaPackage(entries: readonly ArchiveEntry[]): ValidationResult {
  const diagnostics: PgnaDiagnostic[] = [];

  const byPath = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    if (!isSafeArchivePath(entry.path)) {
      diagnostics.push({
        code: "UNSAFE_ARCHIVE_PATH",
        severity: "error",
        path: entry.path,
        message: `Archive path "${entry.path}" violates PGNA v1.0 §2.1 POSIX safety rules.`,
      });
      continue;
    }
    if (!isOsMetadataPath(entry.path)) {
      byPath.set(entry.path, entry);
    }
  }

  const manifestEntry = byPath.get("manifest.json");
  if (!manifestEntry) {
    diagnostics.push({
      code: "MISSING_MANIFEST",
      severity: "error",
      path: "manifest.json",
      message: 'Required archive entry "manifest.json" is missing.',
    });
    return { valid: false, diagnostics };
  }

  let manifest: PgnaManifest;
  try {
    manifest = JSON.parse(utf8Decode(manifestEntry.data)) as PgnaManifest;
  } catch (err) {
    diagnostics.push({
      code: "INVALID_MANIFEST_JSON",
      severity: "error",
      path: "manifest.json",
      message: `Failed to parse manifest.json: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, diagnostics };
  }

  const audioPaths = new Set<string>();
  const subtitlePaths = new Set<string>();
  for (const clip of Object.values(manifest.clips ?? {})) {
    if (clip.path) audioPaths.add(clip.path);
    if (clip.subtitles) {
      for (const sp of Object.values(clip.subtitles)) {
        subtitlePaths.add(sp);
      }
    }
  }

  // Enforce audio STORE (method 0) and existence
  for (const audioPath of audioPaths) {
    const audioEntry = byPath.get(audioPath);
    if (!audioEntry) {
      diagnostics.push({
        code: "MISSING_ARCHIVE_ENTRY",
        severity: "error",
        path: audioPath,
        message: `Referenced audio clip "${audioPath}" is missing from the archive.`,
      });
    } else if (audioEntry.compressionMethod !== ZIP_METHOD_STORE) {
      diagnostics.push({
        code: "AUDIO_NOT_STORED",
        severity: "error",
        path: audioPath,
        message: `Audio clip "${audioPath}" MUST use ZIP STORE (method 0), found method ${audioEntry.compressionMethod}.`,
      });
    }
  }

  const subtitlesByPath: Record<string, string> = {};
  for (const subPath of subtitlePaths) {
    const subEntry = byPath.get(subPath);
    if (!subEntry) {
      diagnostics.push({
        code: "MISSING_ARCHIVE_ENTRY",
        severity: "error",
        path: subPath,
        message: `Referenced subtitle track "${subPath}" is missing from the archive.`,
      });
    } else {
      subtitlesByPath[subPath] = utf8Decode(subEntry.data);
    }
  }

  const pgnEntry = byPath.get(manifest.pgnPath);
  if (!pgnEntry) {
    diagnostics.push({
      code: "MISSING_ARCHIVE_ENTRY",
      severity: "error",
      path: manifest.pgnPath,
      message: `Required PGN entry "${manifest.pgnPath}" is missing from the archive.`,
    });
  }

  const timelineEntry = byPath.get(manifest.timelinePath);
  if (!timelineEntry) {
    diagnostics.push({
      code: "MISSING_ARCHIVE_ENTRY",
      severity: "error",
      path: manifest.timelinePath,
      message: `Required timeline entry "${manifest.timelinePath}" is missing from the archive.`,
    });
  }

  if (!pgnEntry || !timelineEntry) {
    return {
      valid: diagnostics.every((d) => d.severity !== "error"),
      diagnostics,
    };
  }

  let archivedTimeline: PgnaTimeline;
  try {
    archivedTimeline = JSON.parse(utf8Decode(timelineEntry.data)) as PgnaTimeline;
  } catch (err) {
    diagnostics.push({
      code: "INVALID_TIMELINE_JSON",
      severity: "error",
      path: manifest.timelinePath,
      message: `Failed to parse ${manifest.timelinePath}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, diagnostics };
  }

  const pgnText = utf8Decode(pgnEntry.data);
  const recompiled = compilePgna({
    manifest,
    pgnText,
    subtitlesByPath,
  });

  diagnostics.push(...recompiled.diagnostics);

  if (!timelinesMatchIgnoringCompiledAt(archivedTimeline, recompiled.timeline)) {
    diagnostics.push({
      code: "STALE_TIMELINE",
      severity: "error",
      path: manifest.timelinePath,
      message: `Archived "${manifest.timelinePath}" does not match deterministic recompilation of "${manifest.pgnPath}" and "manifest.json".`,
    });
  }

  return {
    valid: diagnostics.every((d) => d.severity !== "error"),
    diagnostics,
  };
}

/**
 * Unpacks raw `.pgna` ZIP bytes and runs full PGNA v1.0 validation.
 */
export async function validatePgnaZip(zipBytes: Uint8Array): Promise<ValidationResult> {
  try {
    const entries = await unpackPgnaZip(zipBytes);
    return validatePgnaPackage(entries);
  } catch (err) {
    return {
      valid: false,
      diagnostics: [
        {
          code: "INVALID_ZIP_ARCHIVE",
          severity: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      ],
    };
  }
}
