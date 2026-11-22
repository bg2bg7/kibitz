import { compilePgna } from "./compiler.js";
import type {
  ArchiveEntry,
  NodeId,
  PgnaDiagnostic,
  PgnaManifest,
  PgnaTimeline,
} from "./types.js";
import {
  isOsMetadataPath,
  unpackPgnaZip,
  utf8Decode,
  type UnpackZipLimits,
} from "./zip.js";

export const ZIP_METHOD_STORE = 0 as const;
export const ZIP_METHOD_DEFLATE = 8 as const;

const NODE_ID_PATTERN = /^g\d+(?:\/\d+(?:\.\d+)*)?$/;
const CLIP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SUBTITLE_LANG_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const FORBIDDEN_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/**
 * Validates BCP 47 safe subtitle language tags (rejecting path traversal and prototype keys).
 */
export function isValidSubtitleLang(lang: string): boolean {
  if (typeof lang !== "string") return false;
  if (FORBIDDEN_OBJECT_KEYS.has(lang)) return false;
  return SUBTITLE_LANG_PATTERN.test(lang);
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

const INVALID_PROJECTION = Symbol("INVALID_PROJECTION");
type ProjectionResult<T> = T | typeof INVALID_PROJECTION;

function projectRecordOfValues(raw: unknown): ProjectionResult<Record<string, unknown>> {
  if (!isPlainObject(raw)) return INVALID_PROJECTION;
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    out[key] = raw[key];
  }
  return out;
}

function projectLastMove(raw: unknown): ProjectionResult<Record<string, unknown> | null> {
  if (raw === null) return null;
  if (!isPlainObject(raw)) return INVALID_PROJECTION;
  return {
    from: raw["from"],
    to: raw["to"],
  };
}

function projectArrow(raw: unknown): ProjectionResult<Record<string, unknown>> {
  if (!isPlainObject(raw)) return INVALID_PROJECTION;
  return {
    color: raw["color"],
    from: raw["from"],
    to: raw["to"],
  };
}

function projectHighlight(raw: unknown): ProjectionResult<Record<string, unknown>> {
  if (!isPlainObject(raw)) return INVALID_PROJECTION;
  return {
    color: raw["color"],
    square: raw["square"],
  };
}

function projectCueSnapshot(raw: unknown): ProjectionResult<Record<string, unknown>> {
  if (!isPlainObject(raw)) return INVALID_PROJECTION;
  if (!Array.isArray(raw["arrows"]) || !Array.isArray(raw["highlights"])) {
    return INVALID_PROJECTION;
  }

  const arrows: Record<string, unknown>[] = [];
  for (const item of raw["arrows"]) {
    const projected = projectArrow(item);
    if (projected === INVALID_PROJECTION) return INVALID_PROJECTION;
    arrows.push(projected);
  }

  const highlights: Record<string, unknown>[] = [];
  for (const item of raw["highlights"]) {
    const projected = projectHighlight(item);
    if (projected === INVALID_PROJECTION) return INVALID_PROJECTION;
    highlights.push(projected);
  }

  return {
    offsetMs: raw["offsetMs"],
    globalTimeMs: raw["globalTimeMs"],
    arrows,
    highlights,
  };
}

function projectResolvedClipAudio(raw: unknown): ProjectionResult<Record<string, unknown> | null> {
  if (raw === null) return null;
  if (!isPlainObject(raw)) return INVALID_PROJECTION;
  return {
    clipId: raw["clipId"],
    path: raw["path"],
    mimeType: raw["mimeType"],
    durationMs: raw["durationMs"],
    trimStartMs: raw["trimStartMs"],
    trimEndMs: raw["trimEndMs"],
  };
}

function projectGuessBranch(raw: unknown): ProjectionResult<Record<string, unknown>> {
  if (!isPlainObject(raw)) return INVALID_PROJECTION;
  if (!Array.isArray(raw["nags"]) || !Array.isArray(raw["branchTimeline"])) {
    return INVALID_PROJECTION;
  }

  const branchTimeline: Record<string, unknown>[] = [];
  for (const step of raw["branchTimeline"]) {
    const projectedStep = projectTimelineEntry(step);
    if (projectedStep === INVALID_PROJECTION) return INVALID_PROJECTION;
    branchTimeline.push(projectedStep);
  }

  return {
    nodeId: raw["nodeId"],
    san: raw["san"],
    from: raw["from"],
    to: raw["to"],
    outcome: raw["outcome"],
    nags: [...raw["nags"]],
    isMainline: raw["isMainline"],
    mainTimelineIndex: raw["mainTimelineIndex"],
    branchTimeline,
    branchDurationMs: raw["branchDurationMs"],
  };
}

function projectGuessSpec(raw: unknown): ProjectionResult<Record<string, unknown>> {
  if (!isPlainObject(raw)) return INVALID_PROJECTION;
  if (!Array.isArray(raw["branches"])) return INVALID_PROJECTION;

  const branches: Record<string, unknown>[] = [];
  for (const branch of raw["branches"]) {
    const projectedBranch = projectGuessBranch(branch);
    if (projectedBranch === INVALID_PROJECTION) return INVALID_PROJECTION;
    branches.push(projectedBranch);
  }

  return {
    promptNodeId: raw["promptNodeId"],
    returnPolicy: raw["returnPolicy"],
    branches,
  };
}

function projectTimelineEntry(raw: unknown): ProjectionResult<Record<string, unknown>> {
  if (!isPlainObject(raw)) return INVALID_PROJECTION;

  const lastMove = projectLastMove(raw["lastMove"]);
  if (lastMove === INVALID_PROJECTION) return INVALID_PROJECTION;

  const audio = projectResolvedClipAudio(raw["audio"]);
  if (audio === INVALID_PROJECTION) return INVALID_PROJECTION;

  if (!Array.isArray(raw["cues"])) return INVALID_PROJECTION;
  const cues: Record<string, unknown>[] = [];
  for (const cue of raw["cues"]) {
    const projectedCue = projectCueSnapshot(cue);
    if (projectedCue === INVALID_PROJECTION) return INVALID_PROJECTION;
    cues.push(projectedCue);
  }

  const out: Record<string, unknown> = {
    index: raw["index"],
    startMs: raw["startMs"],
    endMs: raw["endMs"],
    gameIndex: raw["gameIndex"],
    nodeId: raw["nodeId"],
    ply: raw["ply"],
    san: raw["san"],
    fen: raw["fen"],
    lastMove,
    orientation: raw["orientation"],
    comment: raw["comment"],
    audio,
    cues,
  };

  if (raw["subtitles"] !== undefined) {
    const subtitles = projectRecordOfValues(raw["subtitles"]);
    if (subtitles === INVALID_PROJECTION) return INVALID_PROJECTION;
    out["subtitles"] = subtitles;
  }

  if (raw["guess"] !== undefined) {
    const guess = projectGuessSpec(raw["guess"]);
    if (guess === INVALID_PROJECTION) return INVALID_PROJECTION;
    out["guess"] = guess;
  }

  if (raw["isRevisit"] !== undefined) {
    out["isRevisit"] = raw["isRevisit"];
  }

  return out;
}

function projectGameMetadata(raw: unknown): ProjectionResult<Record<string, unknown>> {
  if (!isPlainObject(raw)) return INVALID_PROJECTION;
  const headers = projectRecordOfValues(raw["headers"]);
  if (headers === INVALID_PROJECTION) return INVALID_PROJECTION;
  return {
    gameIndex: raw["gameIndex"],
    headers,
    initialFen: raw["initialFen"],
    orientation: raw["orientation"],
  };
}

function projectNodeIndexEntry(raw: unknown): ProjectionResult<Record<string, unknown>> {
  if (!isPlainObject(raw)) return INVALID_PROJECTION;
  const lastMove = projectLastMove(raw["lastMove"]);
  if (lastMove === INVALID_PROJECTION) return INVALID_PROJECTION;
  if (!Array.isArray(raw["timelineIndices"])) return INVALID_PROJECTION;

  const out: Record<string, unknown> = {
    gameIndex: raw["gameIndex"],
    fen: raw["fen"],
    lastMove,
    orientation: raw["orientation"],
    clipId: raw["clipId"],
    timelineIndex: raw["timelineIndex"],
    timelineIndices: [...raw["timelineIndices"]],
  };

  if (raw["subtitles"] !== undefined) {
    const subtitles = projectRecordOfValues(raw["subtitles"]);
    if (subtitles === INVALID_PROJECTION) return INVALID_PROJECTION;
    out["subtitles"] = subtitles;
  }

  return out;
}

/**
 * Projects a raw parsed timeline object onto only known PGNA v1.0 schema properties,
 * ignoring `compiledAt` and any unrecognized forward-compatible additive properties (§2.2).
 */
function projectTimelineV1(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null;
  if (!Array.isArray(raw["games"]) || !Array.isArray(raw["entries"])) return null;
  if (!isPlainObject(raw["nodeIndex"])) return null;

  const games: Record<string, unknown>[] = [];
  for (const game of raw["games"]) {
    const projectedGame = projectGameMetadata(game);
    if (projectedGame === INVALID_PROJECTION) return null;
    games.push(projectedGame);
  }

  const entries: Record<string, unknown>[] = [];
  for (const entry of raw["entries"]) {
    const projectedEntry = projectTimelineEntry(entry);
    if (projectedEntry === INVALID_PROJECTION) return null;
    entries.push(projectedEntry);
  }

  const nodeIndex = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(raw["nodeIndex"])) {
    const projectedNode = projectNodeIndexEntry(raw["nodeIndex"][key]);
    if (projectedNode === INVALID_PROJECTION) return null;
    nodeIndex[key] = projectedNode;
  }

  const out: Record<string, unknown> = {
    format: raw["format"],
    version: raw["version"],
    totalDurationMs: raw["totalDurationMs"],
    games,
    entries,
    nodeIndex,
  };

  if (raw["mergedSubtitles"] !== undefined) {
    const mergedSubtitles = projectRecordOfValues(raw["mergedSubtitles"]);
    if (mergedSubtitles === INVALID_PROJECTION) return null;
    out["mergedSubtitles"] = mergedSubtitles;
  }

  if (raw["guesses"] !== undefined) {
    if (!isPlainObject(raw["guesses"])) return null;
    const guesses = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(raw["guesses"])) {
      const projectedSpec = projectGuessSpec(raw["guesses"][key]);
      if (projectedSpec === INVALID_PROJECTION) return null;
      guesses[key] = projectedSpec;
    }
    out["guesses"] = guesses;
  }

  return out;
}

function timelinesMatchIgnoringCompiledAt(archived: unknown, recompiled: PgnaTimeline): boolean {
  const projectedArchived = projectTimelineV1(archived);
  if (!projectedArchived) return false;
  const projectedRecompiled = projectTimelineV1(recompiled);
  if (!projectedRecompiled) return false;
  return stableJsonStringify(projectedArchived) === stableJsonStringify(projectedRecompiled);
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
 * - POSIX archive path safety (§2.1) & duplicate entry rejection
 * - Required entries (`manifest.json`, `pgnPath`, `timelinePath`)
 * - Audio clips present & compressed with ZIP STORE method 0 (§2)
 * - Re-compiles `manifest` + PGN + per-clip subtitles and rejects stale/divergent `timeline.json`
 *   (ignoring `compiledAt` and forward-compatible additive properties) with `STALE_TIMELINE` (§6)
 * - Verifies compiler-generated merged subtitles (`MISSING_ARCHIVE_ENTRY` / `STALE_SUBTITLES`).
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
    if (isOsMetadataPath(entry.path)) {
      continue;
    }
    if (byPath.has(entry.path)) {
      diagnostics.push({
        code: "DUPLICATE_ARCHIVE_ENTRY",
        severity: "error",
        path: entry.path,
        message: `Duplicate archive entry "${entry.path}".`,
      });
      continue;
    }
    byPath.set(entry.path, entry);
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

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(utf8Decode(manifestEntry.data));
  } catch (err) {
    diagnostics.push({
      code: "INVALID_MANIFEST_JSON",
      severity: "error",
      path: "manifest.json",
      message: `Failed to parse manifest.json: ${err instanceof Error ? err.message : String(err)}`,
    });
    return { valid: false, diagnostics };
  }

  if (!isPlainObject(rawManifest)) {
    diagnostics.push({
      code: "INVALID_MANIFEST_JSON",
      severity: "error",
      path: "manifest.json",
      message: "manifest.json must contain a JSON object.",
    });
    return { valid: false, diagnostics };
  }

  const rawPgnPath = rawManifest["pgnPath"];
  const pgnPath =
    rawPgnPath === undefined
      ? "study.pgn"
      : typeof rawPgnPath === "string" && isSafeArchivePath(rawPgnPath)
        ? rawPgnPath
        : null;

  const rawTimelinePath = rawManifest["timelinePath"];
  const timelinePath =
    rawTimelinePath === undefined
      ? "timeline.json"
      : typeof rawTimelinePath === "string" && isSafeArchivePath(rawTimelinePath)
        ? rawTimelinePath
        : null;

  const audioPaths = new Set<string>();
  const subtitlePaths = new Set<string>();
  const rawClips = rawManifest["clips"];
  if (isPlainObject(rawClips)) {
    for (const rawClip of Object.values(rawClips)) {
      if (!isPlainObject(rawClip)) continue;
      const clipPath = rawClip["path"];
      if (typeof clipPath === "string" && isSafeArchivePath(clipPath)) {
        audioPaths.add(clipPath);
      }
      const clipSubtitles = rawClip["subtitles"];
      if (isPlainObject(clipSubtitles)) {
        for (const sp of Object.values(clipSubtitles)) {
          if (typeof sp === "string" && isSafeArchivePath(sp)) {
            subtitlePaths.add(sp);
          }
        }
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

  const pgnEntry = pgnPath !== null ? byPath.get(pgnPath) : undefined;
  if (pgnPath !== null && !pgnEntry) {
    diagnostics.push({
      code: "MISSING_ARCHIVE_ENTRY",
      severity: "error",
      path: pgnPath,
      message: `Required PGN entry "${pgnPath}" is missing from the archive.`,
    });
  }

  const timelineEntry = timelinePath !== null ? byPath.get(timelinePath) : undefined;
  if (timelinePath !== null && !timelineEntry) {
    diagnostics.push({
      code: "MISSING_ARCHIVE_ENTRY",
      severity: "error",
      path: timelinePath,
      message: `Required timeline entry "${timelinePath}" is missing from the archive.`,
    });
  }

  // Always run manifest/clip compilation validation even when PGN or timeline entries are missing
  const pgnText = pgnEntry ? utf8Decode(pgnEntry.data) : "";
  const recompiled = compilePgna({
    manifest: rawManifest as unknown as PgnaManifest,
    pgnText,
    subtitlesByPath,
  });
  diagnostics.push(...recompiled.diagnostics);

  if (timelineEntry && timelinePath !== null) {
    let rawArchivedTimeline: unknown;
    let parsedTimelineOk = false;
    try {
      rawArchivedTimeline = JSON.parse(utf8Decode(timelineEntry.data));
      parsedTimelineOk = true;
    } catch (err) {
      diagnostics.push({
        code: "INVALID_TIMELINE_JSON",
        severity: "error",
        path: timelinePath,
        message: `Failed to parse ${timelinePath}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (parsedTimelineOk) {
      if (!isPlainObject(rawArchivedTimeline)) {
        diagnostics.push({
          code: "INVALID_TIMELINE_JSON",
          severity: "error",
          path: timelinePath,
          message: `${timelinePath} must contain a JSON object.`,
        });
      } else if (
        pgnEntry &&
        !timelinesMatchIgnoringCompiledAt(rawArchivedTimeline, recompiled.timeline)
      ) {
        diagnostics.push({
          code: "STALE_TIMELINE",
          severity: "error",
          path: timelinePath,
          message: `Archived "${timelinePath}" does not match deterministic recompilation of "${pgnPath}" and "manifest.json".`,
        });
      }
    }
  }

  // Verify compiler-generated merged subtitle tracks when PGN was present
  if (pgnEntry) {
    for (const [mergedPath, expectedVtt] of Object.entries(recompiled.mergedSubtitlesVtt)) {
      const mergedEntry = byPath.get(mergedPath);
      if (!mergedEntry) {
        diagnostics.push({
          code: "MISSING_ARCHIVE_ENTRY",
          severity: "error",
          path: mergedPath,
          message: `Required merged subtitle track "${mergedPath}" is missing from the archive.`,
        });
      } else if (utf8Decode(mergedEntry.data) !== expectedVtt) {
        diagnostics.push({
          code: "STALE_SUBTITLES",
          severity: "error",
          path: mergedPath,
          message: `Archived merged subtitle track "${mergedPath}" does not match deterministic recompilation.`,
        });
      }
    }
  }

  return {
    valid: diagnostics.every((d) => d.severity !== "error"),
    diagnostics,
  };
}

/**
 * Unpacks raw `.pgna` ZIP bytes and runs full PGNA v1.0 validation.
 */
export async function validatePgnaZip(
  zipBytes: Uint8Array,
  limits?: UnpackZipLimits,
): Promise<ValidationResult> {
  try {
    const entries = await unpackPgnaZip(zipBytes, limits);
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
