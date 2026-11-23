import {
  ChessPosition,
  INITIAL_FEN,
  getPgnTextualNodeOrder,
  parsePgnGames,
  validateFen,
} from "@suite/chess-core";
import { applyCueDirectives, compareAtTags, parseNodeComments } from "./tags.js";
import {
  DEFAULT_GAP_MS,
  DEFAULT_RETURN_PAUSE_MS,
  DEFAULT_SILENT_DURATION_MS,
  PGNA_FORMAT_VERSION,
  type ArrowAnnotation,
  type BoardOrientation,
  type ClipDefinition,
  type CompilationOptions,
  type CueSnapshot,
  type GuessBranch,
  type GuessOutcome,
  type GuessSpec,
  type LastMoveCoords,
  type NodeId,
  type NodeIndexEntry,
  type ParsedAtTag,
  type ParsedNodeTags,
  type PgnaDiagnostic,
  type PgnaManifest,
  type PgnaTimeline,
  type ResolvedClipAudio,
  type SquareHighlight,
  type TimelineEntry,
  type TimelineGameMetadata,
} from "./types.js";
import { isSafeArchivePath, isValidClipId, isValidSubtitleLang } from "./validator.js";
import { mergeTimelineSubtitles } from "./vtt.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNullProtoStringRecord(
  input: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Validates that a timeline interval `[startMs, endMs]` is finite, strictly advancing,
 * non-negative, and within JavaScript's JSON-safe integer bound (`Number.MAX_SAFE_INTEGER`).
 */
export function isValidTimelineInterval(startMs: number, endMs: number): boolean {
  return (
    typeof startMs === "number" &&
    typeof endMs === "number" &&
    Number.isFinite(startMs) &&
    Number.isFinite(endMs) &&
    startMs >= 0 &&
    endMs > startMs &&
    startMs <= Number.MAX_SAFE_INTEGER &&
    endMs <= Number.MAX_SAFE_INTEGER
  );
}

export interface CompilePgnaInput {
  manifest: PgnaManifest;
  pgnText: string;
  /** Optional map of archive path -> raw WebVTT text for per-clip subtitle merging. */
  subtitlesByPath?: Record<string, string>;
  /** Optional deterministic ISO timestamp for `timeline.compiledAt`. */
  compiledAt?: string;
}

export interface CompilePgnaResult {
  timeline: PgnaTimeline;
  mergedSubtitlesVtt: Record<string, string>;
  diagnostics: PgnaDiagnostic[];
}

interface CompiledNode {
  nodeId: NodeId;
  gameIndex: number;
  ply: number;
  san: string | null;
  fen: string;
  lastMove: LastMoveCoords | null;
  orientation: BoardOrientation;
  nags: string[];
  tags: ParsedNodeTags;
  documentOrder: number;
  siblingIndex: number;
  children: CompiledNode[];
}

interface ScheduledOccurrence {
  node: CompiledNode;
  atTag: ParsedAtTag | null;
  tagIndexOnNode: number;
  isUnscheduledAudio: boolean;
}

function cloneArrows(arrows: readonly ArrowAnnotation[]): ArrowAnnotation[] {
  return arrows.map((a) => ({ color: a.color, from: a.from, to: a.to }));
}

function cloneHighlights(highlights: readonly SquareHighlight[]): SquareHighlight[] {
  return highlights.map((h) => ({ color: h.color, square: h.square }));
}

function resolveCompilationOptions(
  raw: Partial<CompilationOptions> | undefined,
  diagnostics: PgnaDiagnostic[],
): CompilationOptions {
  if (raw !== undefined && !isPlainObject(raw)) {
    diagnostics.push({
      code: "INVALID_COMPILATION_OPTIONS",
      severity: "error",
      message: "Invalid manifest.compilation: expected an object.",
    });
    return {
      timingMode: "flow",
      defaultSilentDurationMs: DEFAULT_SILENT_DURATION_MS,
      defaultReturnPauseMs: DEFAULT_RETURN_PAUSE_MS,
      defaultGapMs: DEFAULT_GAP_MS,
      includeUnscheduledAudio: false,
    };
  }

  const timingModeRaw: unknown =
    raw && raw.timingMode !== undefined ? raw.timingMode : "flow";
  let timingMode: "flow" | "strict" = "flow";
  if (timingModeRaw === "flow" || timingModeRaw === "strict") {
    timingMode = timingModeRaw;
  } else {
    diagnostics.push({
      code: "INVALID_COMPILATION_OPTIONS",
      severity: "error",
      message: `Invalid compilation.timingMode "${String(timingModeRaw)}": expected "flow" or "strict".`,
    });
  }

  const defaultSilentRaw: unknown =
    raw && raw.defaultSilentDurationMs !== undefined
      ? raw.defaultSilentDurationMs
      : DEFAULT_SILENT_DURATION_MS;
  let defaultSilentDurationMs: number = DEFAULT_SILENT_DURATION_MS;
  if (
    typeof defaultSilentRaw === "number" &&
    Number.isFinite(defaultSilentRaw) &&
    defaultSilentRaw > 0 &&
    defaultSilentRaw <= Number.MAX_SAFE_INTEGER
  ) {
    defaultSilentDurationMs = defaultSilentRaw;
  } else {
    diagnostics.push({
      code: "INVALID_COMPILATION_OPTIONS",
      severity: "error",
      message: `Invalid compilation.defaultSilentDurationMs "${String(defaultSilentRaw)}": must be a finite number > 0 and <= MAX_SAFE_INTEGER.`,
    });
  }

  const defaultReturnRaw: unknown =
    raw && raw.defaultReturnPauseMs !== undefined
      ? raw.defaultReturnPauseMs
      : DEFAULT_RETURN_PAUSE_MS;
  let defaultReturnPauseMs: number = DEFAULT_RETURN_PAUSE_MS;
  if (
    typeof defaultReturnRaw === "number" &&
    Number.isFinite(defaultReturnRaw) &&
    defaultReturnRaw > 0 &&
    defaultReturnRaw <= Number.MAX_SAFE_INTEGER
  ) {
    defaultReturnPauseMs = defaultReturnRaw;
  } else {
    diagnostics.push({
      code: "INVALID_COMPILATION_OPTIONS",
      severity: "error",
      message: `Invalid compilation.defaultReturnPauseMs "${String(defaultReturnRaw)}": must be a finite number > 0 and <= MAX_SAFE_INTEGER.`,
    });
  }

  const defaultGapRaw: unknown =
    raw && raw.defaultGapMs !== undefined ? raw.defaultGapMs : DEFAULT_GAP_MS;
  let defaultGapMs: number = DEFAULT_GAP_MS;
  if (
    typeof defaultGapRaw === "number" &&
    Number.isFinite(defaultGapRaw) &&
    defaultGapRaw >= 0 &&
    defaultGapRaw <= Number.MAX_SAFE_INTEGER
  ) {
    defaultGapMs = defaultGapRaw;
  } else {
    diagnostics.push({
      code: "INVALID_COMPILATION_OPTIONS",
      severity: "error",
      message: `Invalid compilation.defaultGapMs "${String(defaultGapRaw)}": must be a finite number >= 0 and <= MAX_SAFE_INTEGER.`,
    });
  }

  const includeUnscheduledRaw: unknown =
    raw && raw.includeUnscheduledAudio !== undefined ? raw.includeUnscheduledAudio : false;
  let includeUnscheduledAudio = false;
  if (typeof includeUnscheduledRaw === "boolean") {
    includeUnscheduledAudio = includeUnscheduledRaw;
  } else {
    diagnostics.push({
      code: "INVALID_COMPILATION_OPTIONS",
      severity: "error",
      message: `Invalid compilation.includeUnscheduledAudio "${String(includeUnscheduledRaw)}": must be a boolean.`,
    });
  }

  return {
    timingMode,
    defaultSilentDurationMs,
    defaultReturnPauseMs,
    defaultGapMs,
    includeUnscheduledAudio,
  };
}

function validateManifestAndClips(
  manifest: PgnaManifest,
  diagnostics: PgnaDiagnostic[],
): Map<string, ResolvedClipAudio & { subtitles?: Record<string, string> }> {
  if (manifest.format !== "pgna") {
    diagnostics.push({
      code: "INVALID_MANIFEST",
      severity: "error",
      message: `Invalid manifest.format "${String(manifest.format)}": expected "pgna".`,
    });
  }
  if (manifest.version !== PGNA_FORMAT_VERSION) {
    diagnostics.push({
      code: "INVALID_MANIFEST",
      severity: "error",
      message: `Unsupported manifest.version "${String(manifest.version)}": expected "${PGNA_FORMAT_VERSION}".`,
    });
  }

  const rawPgnPath: unknown = manifest.pgnPath;
  const effectivePgnPath = rawPgnPath === undefined ? "study.pgn" : rawPgnPath;
  if (typeof effectivePgnPath !== "string") {
    diagnostics.push({
      code: "INVALID_MANIFEST",
      severity: "error",
      message: `Invalid manifest.pgnPath: expected a string, got ${typeof effectivePgnPath}.`,
    });
  } else if (!isSafeArchivePath(effectivePgnPath)) {
    diagnostics.push({
      code: "UNSAFE_ARCHIVE_PATH",
      severity: "error",
      path: effectivePgnPath,
      message: `Unsafe manifest.pgnPath "${effectivePgnPath}".`,
    });
  }

  const rawTimelinePath: unknown = manifest.timelinePath;
  const effectiveTimelinePath = rawTimelinePath === undefined ? "timeline.json" : rawTimelinePath;
  if (typeof effectiveTimelinePath !== "string") {
    diagnostics.push({
      code: "INVALID_MANIFEST",
      severity: "error",
      message: `Invalid manifest.timelinePath: expected a string, got ${typeof effectiveTimelinePath}.`,
    });
  } else if (!isSafeArchivePath(effectiveTimelinePath)) {
    diagnostics.push({
      code: "UNSAFE_ARCHIVE_PATH",
      severity: "error",
      path: effectiveTimelinePath,
      message: `Unsafe manifest.timelinePath "${effectiveTimelinePath}".`,
    });
  }

  const resolvedClips = new Map<string, ResolvedClipAudio & { subtitles?: Record<string, string> }>();
  const rawClips: unknown = manifest.clips;
  if (rawClips !== undefined && !isPlainObject(rawClips)) {
    diagnostics.push({
      code: "INVALID_MANIFEST",
      severity: "error",
      message: "Invalid manifest.clips: expected a plain object.",
    });
    return resolvedClips;
  }

  const clips = (rawClips ?? {}) as Record<string, unknown>;

  for (const [clipId, rawClip] of Object.entries(clips)) {
    if (!isValidClipId(clipId)) {
      diagnostics.push({
        code: "INVALID_CLIP_ID",
        severity: "error",
        message: `Invalid clip ID "${clipId}" in manifest.clips.`,
      });
      continue;
    }
    if (!isPlainObject(rawClip)) {
      diagnostics.push({
        code: "INVALID_MANIFEST",
        severity: "error",
        message: `Invalid clip entry "${clipId}" in manifest.clips: expected an object.`,
      });
      continue;
    }

    const clip = rawClip as unknown as ClipDefinition;
    if (clip.id !== clipId) {
      diagnostics.push({
        code: "CLIP_ID_MISMATCH",
        severity: "error",
        message: `Clip "${clipId}" has mismatched inner id "${String(clip.id)}".`,
      });
    }

    const clipPath: unknown = clip.path;
    const validClipPath = typeof clipPath === "string" && isSafeArchivePath(clipPath);
    if (typeof clipPath !== "string") {
      diagnostics.push({
        code: "INVALID_MANIFEST",
        severity: "error",
        message: `Clip "${clipId}" path must be a string.`,
      });
    } else if (!isSafeArchivePath(clipPath)) {
      diagnostics.push({
        code: "UNSAFE_ARCHIVE_PATH",
        severity: "error",
        path: clipPath,
        message: `Unsafe clip path "${clipPath}" for clip "${clipId}".`,
      });
    }

    const validSubtitles: Record<string, string> = {};
    const rawSubtitles: unknown = clip.subtitles;
    if (rawSubtitles !== undefined) {
      if (!isPlainObject(rawSubtitles)) {
        diagnostics.push({
          code: "INVALID_MANIFEST",
          severity: "error",
          message: `Clip "${clipId}" subtitles must be an object.`,
        });
      } else {
        for (const [lang, subPath] of Object.entries(rawSubtitles)) {
          if (!isValidSubtitleLang(lang)) {
            diagnostics.push({
              code: "INVALID_SUBTITLE_LANG",
              severity: "error",
              message: `Invalid subtitle language tag "${lang}" for clip "${clipId}".`,
            });
            continue;
          }
          if (typeof subPath !== "string") {
            diagnostics.push({
              code: "INVALID_MANIFEST",
              severity: "error",
              message: `Subtitle path for language "${lang}" on clip "${clipId}" must be a string.`,
            });
            continue;
          }
          if (!isSafeArchivePath(subPath)) {
            diagnostics.push({
              code: "UNSAFE_ARCHIVE_PATH",
              severity: "error",
              path: subPath,
              message: `Unsafe subtitle path "${subPath}" for clip "${clipId}".`,
            });
            continue;
          }
          validSubtitles[lang] = subPath;
        }
      }
    }

    if (
      typeof clip.durationMs !== "number" ||
      !Number.isFinite(clip.durationMs) ||
      clip.durationMs <= 0 ||
      clip.durationMs > Number.MAX_SAFE_INTEGER
    ) {
      diagnostics.push({
        code: "INVALID_CLIP_DURATION",
        severity: "error",
        ...(typeof clipPath === "string" ? { path: clipPath } : {}),
        message: `Clip "${clipId}" durationMs must be a finite number > 0 and <= MAX_SAFE_INTEGER.`,
      });
      continue;
    }

    const trimStartMs: unknown = clip.trimStartMs === undefined ? 0 : clip.trimStartMs;
    const trimEndMs: unknown = clip.trimEndMs === undefined ? clip.durationMs : clip.trimEndMs;
    if (
      typeof trimStartMs !== "number" ||
      typeof trimEndMs !== "number" ||
      !Number.isFinite(trimStartMs) ||
      !Number.isFinite(trimEndMs) ||
      trimStartMs < 0 ||
      trimEndMs <= trimStartMs ||
      trimEndMs > clip.durationMs
    ) {
      diagnostics.push({
        code: "INVALID_CLIP_TRIM",
        severity: "error",
        ...(typeof clipPath === "string" ? { path: clipPath } : {}),
        message: `Clip "${clipId}" has invalid trim bounds [${String(trimStartMs)}, ${String(trimEndMs)}] for durationMs ${clip.durationMs}.`,
      });
      continue;
    }

    resolvedClips.set(clipId, {
      clipId,
      path: validClipPath ? clipPath : typeof clipPath === "string" ? clipPath : "",
      mimeType: typeof clip.mimeType === "string" ? clip.mimeType : "",
      durationMs: clip.durationMs,
      trimStartMs,
      trimEndMs,
      ...(Object.keys(validSubtitles).length > 0 ? { subtitles: validSubtitles } : {}),
    });
  }

  return resolvedClips;
}

function resolveGameOrientation(
  headers: Record<string, string>,
  gameIndex: number,
  diagnostics: PgnaDiagnostic[],
): BoardOrientation {
  const rawOriginal = headers["Orientation"];
  const raw = rawOriginal?.trim().toLowerCase();
  if (!raw) return "white";
  if (raw === "white" || raw === "black") {
    return raw;
  }
  diagnostics.push({
    code: "INVALID_ORIENTATION_HEADER",
    severity: "warning",
    nodeId: `g${gameIndex}` as NodeId,
    message: `Invalid [Orientation "${rawOriginal ?? ""}"] header in game ${gameIndex}; defaulting to "white".`,
  });
  return "white";
}

function getParentNodeId(nodeId: NodeId): NodeId | null {
  const lastDot = nodeId.lastIndexOf(".");
  if (lastDot !== -1) {
    return nodeId.slice(0, lastDot) as NodeId;
  }
  const slash = nodeId.indexOf("/");
  if (slash !== -1) {
    return nodeId.slice(0, slash) as NodeId;
  }
  return null;
}

function compileCuesForEntry(
  node: CompiledNode,
  entryStartMs: number,
  trimStartMs: number,
  trimEndMs: number,
  isRevisit: boolean,
  diagnostics: PgnaDiagnostic[],
  emitCueDiagnostics = true,
): CueSnapshot[] {
  let state = {
    arrows: cloneArrows(node.tags.arrows),
    highlights: cloneHighlights(node.tags.highlights),
  };

  if (isRevisit) {
    return [
      {
        offsetMs: 0,
        globalTimeMs: entryStartMs,
        arrows: state.arrows,
        highlights: state.highlights,
      },
    ];
  }

  // Stable sort by raw offsetMs
  const sortedCues = node.tags.cues
    .map((cue, idx) => ({ cue, idx }))
    .sort((a, b) => a.cue.offsetMs - b.cue.offsetMs || a.idx - b.idx);

  // Fold cues at or before trimStartMs into the baseline offsetMs: 0 snapshot
  for (const { cue } of sortedCues) {
    if (cue.offsetMs <= trimStartMs) {
      state = applyCueDirectives(state, cue.directives);
    }
  }

  const snapshots: CueSnapshot[] = [
    {
      offsetMs: 0,
      globalTimeMs: entryStartMs,
      arrows: cloneArrows(state.arrows),
      highlights: cloneHighlights(state.highlights),
    },
  ];

  for (const { cue } of sortedCues) {
    if (cue.offsetMs <= trimStartMs) {
      continue;
    }
    if (cue.offsetMs >= trimEndMs) {
      if (emitCueDiagnostics) {
        diagnostics.push({
          code: "CUE_OUT_OF_BOUNDS",
          severity: "warning",
          nodeId: node.nodeId,
          message: `Cue at ${cue.offsetMs}ms on node ${node.nodeId} falls at or beyond trimEndMs (${trimEndMs}ms) and was omitted.`,
        });
      }
      continue;
    }

    state = applyCueDirectives(state, cue.directives);
    const relOffsetMs = cue.offsetMs - trimStartMs;
    const globalTimeMs = entryStartMs + relOffsetMs;
    const prev = snapshots[snapshots.length - 1];
    if (prev && prev.offsetMs === relOffsetMs) {
      prev.arrows = cloneArrows(state.arrows);
      prev.highlights = cloneHighlights(state.highlights);
    } else {
      snapshots.push({
        offsetMs: relOffsetMs,
        globalTimeMs,
        arrows: cloneArrows(state.arrows),
        highlights: cloneHighlights(state.highlights),
      });
    }
  }

  return snapshots;
}

function classifyGuessOutcome(child: CompiledNode, isMainline: boolean): GuessOutcome {
  // 1. Explicit [%outcome] tag
  if (child.tags.outcome) {
    return child.tags.outcome;
  }

  // 2. Standard PGN NAG assessment
  for (const nag of child.nags) {
    if (nag === "$1" || nag === "$3") return "success";
    if (nag === "$5") return "interesting";
    if (nag === "$6") return "dubious";
    if (nag === "$2" || nag === "$4") return "fail";
  }

  // 3. Fallback default
  return isMainline ? "success" : "fail";
}

function getPrimaryAtTagDurMs(node: CompiledNode): number | undefined {
  if (node.tags.atTags.length === 0) return undefined;
  const earliest = node.tags.atTags
    .map((tag, idx) => ({ tag, idx }))
    .sort((a, b) => compareAtTags(a.tag, b.tag) || a.idx - b.idx)[0];
  return earliest?.tag.durMs;
}

function buildEntryFromNode(
  node: CompiledNode,
  index: number,
  startMs: number,
  durationMs: number,
  resolvedClip: (ResolvedClipAudio & { subtitles?: Record<string, string> }) | null,
  isRevisit: boolean,
  diagnostics: PgnaDiagnostic[],
  emitCueDiagnostics = true,
): TimelineEntry {
  const audio: ResolvedClipAudio | null =
    !isRevisit && resolvedClip
      ? {
          clipId: resolvedClip.clipId,
          path: resolvedClip.path,
          mimeType: resolvedClip.mimeType,
          durationMs: resolvedClip.durationMs,
          trimStartMs: resolvedClip.trimStartMs,
          trimEndMs: resolvedClip.trimEndMs,
        }
      : null;

  const trimStartMs = audio ? audio.trimStartMs : 0;
  const trimEndMs = audio ? audio.trimEndMs : durationMs;

  const cues = compileCuesForEntry(
    node,
    startMs,
    trimStartMs,
    trimEndMs,
    isRevisit,
    diagnostics,
    emitCueDiagnostics,
  );

  const entry: TimelineEntry = {
    index,
    startMs,
    endMs: startMs + durationMs,
    gameIndex: node.gameIndex,
    nodeId: node.nodeId,
    ply: node.ply,
    san: node.san,
    fen: node.fen,
    lastMove: node.lastMove ? { ...node.lastMove } : null,
    orientation: node.orientation,
    comment: node.tags.prose,
    audio,
    cues,
  };

  if (!isRevisit && resolvedClip?.subtitles) {
    entry.subtitles = { ...resolvedClip.subtitles };
  }

  if (isRevisit) {
    entry.isRevisit = true;
  }

  return entry;
}

/**
 * Compiles a PGNA manifest + multi-game PGN + optional per-clip WebVTT subtitles into
 * a deterministic PGNA v1.0 `timeline.json`, merged WebVTT tracks, and diagnostics.
 */
export function compilePgna(input: CompilePgnaInput): CompilePgnaResult {
  const diagnostics: PgnaDiagnostic[] = [];
  const options = resolveCompilationOptions(input.manifest.compilation, diagnostics);
  const resolvedClips = validateManifestAndClips(input.manifest, diagnostics);

  const parsedGames = parsePgnGames(input.pgnText);
  const gamesMeta: TimelineGameMetadata[] = [];
  const allNodes: CompiledNode[] = [];
  const nodeById = new Map<NodeId, CompiledNode>();
  let docOrderCounter = 0;

  for (let gameIndex = 0; gameIndex < parsedGames.length; gameIndex++) {
    const game = parsedGames[gameIndex]!;

    const rawVariant = game.headers["Variant"]?.trim();
    if (
      rawVariant !== undefined &&
      rawVariant.length > 0 &&
      rawVariant.toLowerCase() !== "standard"
    ) {
      diagnostics.push({
        code: "UNSUPPORTED_VARIANT",
        severity: "error",
        nodeId: `g${gameIndex}` as NodeId,
        message: `Unsupported [Variant "${rawVariant}"] in game ${gameIndex}: PGNA v1.0 only supports Standard chess.`,
      });
      continue;
    }

    const rawFen = game.headers["FEN"]?.trim();
    const initialFen = rawFen && rawFen.length > 0 ? rawFen : INITIAL_FEN;
    const gameOrientation = resolveGameOrientation(game.headers, gameIndex, diagnostics);

    if (!validateFen(initialFen)) {
      diagnostics.push({
        code: "INVALID_FEN",
        severity: "error",
        nodeId: `g${gameIndex}` as NodeId,
        message: `Invalid [FEN "${initialFen}"] in game ${gameIndex}.`,
      });
      continue;
    }

    gamesMeta.push({
      gameIndex,
      headers: { ...game.headers },
      initialFen,
      orientation: gameOrientation,
    });

    const rootNodeId = `g${gameIndex}` as NodeId;
    const { tags: rootTags, diagnostics: rootTagDiags } = parseNodeComments(
      game.rootComments,
      rootNodeId,
    );
    diagnostics.push(...rootTagDiags);

    const rootNode: CompiledNode = {
      nodeId: rootNodeId,
      gameIndex,
      ply: 0,
      san: null,
      fen: initialFen,
      lastMove: null,
      orientation: rootTags.orientation ?? gameOrientation,
      nags: [],
      tags: rootTags,
      documentOrder: docOrderCounter++,
      siblingIndex: 0,
      children: [],
    };

    allNodes.push(rootNode);
    nodeById.set(rootNodeId, rootNode);

    // Walk game nodes in exact PGN textual source order (preserving nested same-ply RAV
    // placement and canonical positional NodeIds) via @suite/chess-core.
    for (const textualEntry of getPgnTextualNodeOrder(game, gameIndex)) {
      const nodeId = textualEntry.nodeId as NodeId;
      const parentId = getParentNodeId(nodeId);
      const parentNode = parentId ? nodeById.get(parentId) : undefined;
      if (!parentNode) {
        continue;
      }

      const pgnNode = textualEntry.node;
      const pos = new ChessPosition(parentNode.fen);
      const applied = pos.tryMove(pgnNode.san);
      if (!applied) {
        diagnostics.push({
          code: "ILLEGAL_MOVE",
          severity: "error",
          nodeId,
          message: `Illegal move "${pgnNode.san}" at ${nodeId} from FEN "${parentNode.fen}".`,
        });
        continue;
      }

      const { tags, diagnostics: tagDiags } = parseNodeComments(pgnNode.comments, nodeId);
      diagnostics.push(...tagDiags);

      const compiled: CompiledNode = {
        nodeId,
        gameIndex,
        ply: textualEntry.ply,
        san: applied.san,
        fen: applied.fen,
        lastMove: { from: applied.from, to: applied.to },
        orientation: tags.orientation ?? gameOrientation,
        nags: [...pgnNode.nags],
        tags,
        documentOrder: docOrderCounter++,
        siblingIndex: textualEntry.siblingIndex,
        children: [],
      };

      parentNode.children.push(compiled);
      allNodes.push(compiled);
      nodeById.set(nodeId, compiled);
    }
  }

  // Validate clip references on all nodes & check single scheduling mode
  let seenOrdinal = false;
  let seenTimestamp = false;
  const scheduledOccurrences: ScheduledOccurrence[] = [];
  const unscheduledAudioOccurrences: ScheduledOccurrence[] = [];

  for (const node of allNodes) {
    if (node.tags.audioClipId !== null && !resolvedClips.has(node.tags.audioClipId)) {
      diagnostics.push({
        code: "MISSING_CLIP_DEFINITION",
        severity: "error",
        nodeId: node.nodeId,
        message: `Node ${node.nodeId} references undefined audio clip "${node.tags.audioClipId}".`,
      });
    }

    if (node.tags.atTags.length > 0) {
      node.tags.atTags.forEach((atTag, tagIndexOnNode) => {
        if (atTag.mode === "ordinal") seenOrdinal = true;
        else seenTimestamp = true;

        scheduledOccurrences.push({
          node,
          atTag,
          tagIndexOnNode,
          isUnscheduledAudio: false,
        });
      });
    } else if (options.includeUnscheduledAudio && node.tags.audioClipId !== null) {
      unscheduledAudioOccurrences.push({
        node,
        atTag: null,
        tagIndexOnNode: 0,
        isUnscheduledAudio: true,
      });
    }
  }

  if (seenOrdinal && seenTimestamp) {
    diagnostics.push({
      code: "MIXED_TIMELINE_MODES",
      severity: "error",
      message:
        "Study mixes sequence ordinals (#N) and explicit timestamps in [%at] tags; a study must use one scheduling mode consistently.",
    });
  }

  // Deterministic sort: key ascending -> PGN document order -> tag order on node
  scheduledOccurrences.sort((a, b) => {
    const cmp = compareAtTags(a.atTag!, b.atTag!);
    if (cmp !== 0) return cmp;
    if (a.node.documentOrder !== b.node.documentOrder) {
      return a.node.documentOrder - b.node.documentOrder;
    }
    return a.tagIndexOnNode - b.tagIndexOnNode;
  });

  const allOccurrences = [...scheduledOccurrences, ...unscheduledAudioOccurrences];

  // Build main timeline entries
  const entries: TimelineEntry[] = [];
  const visitedNodes = new Set<NodeId>();
  const cueDiagnosticsEmitted = new Set<NodeId>();
  const timelineIndicesByNode = new Map<NodeId, number[]>();

  for (const occ of allOccurrences) {
    const { node, atTag } = occ;
    const isRevisit = visitedNodes.has(node.nodeId);

    const clipDef =
      !isRevisit && node.tags.audioClipId !== null
        ? (resolvedClips.get(node.tags.audioClipId) ?? null)
        : null;

    let durationMs: number;
    if (isRevisit) {
      // Revisit is ALWAYS silent; duration is per-tag dur= or defaultReturnPauseMs
      durationMs = atTag?.durMs ?? options.defaultReturnPauseMs;
    } else if (clipDef) {
      durationMs = clipDef.trimEndMs - clipDef.trimStartMs;
      if (atTag?.durMs !== undefined || node.tags.durMs !== null) {
        diagnostics.push({
          code: "IGNORED_DUR_TAG",
          severity: "warning",
          nodeId: node.nodeId,
          message: `Duration override on primary audio node ${node.nodeId} ignored; audio clip trimmed duration (${durationMs}ms) takes precedence.`,
        });
      }
    } else {
      durationMs = atTag?.durMs ?? node.tags.durMs ?? options.defaultSilentDurationMs;
    }

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      diagnostics.push({
        code: "ZERO_ENTRY_DURATION",
        severity: "error",
        nodeId: node.nodeId,
        message: `Resolved timeline entry duration for ${node.nodeId} must be > 0ms (got ${durationMs}ms).`,
      });
      continue;
    }

    const prevEntry = entries[entries.length - 1];
    let startMs: number;

    if (!prevEntry) {
      startMs = atTag?.mode === "timestamp" ? atTag.value : 0;
    } else if (atTag?.mode === "timestamp") {
      if (options.timingMode === "strict") {
        if (atTag.value < prevEntry.endMs) {
          diagnostics.push({
            code: "TIMELINE_OVERLAP",
            severity: "error",
            nodeId: node.nodeId,
            message: `Strict timeline overlap at ${node.nodeId}: declared start ${atTag.value}ms < previous end ${prevEntry.endMs}ms.`,
          });
        }
        startMs = atTag.value;
      } else {
        const minStartMs = prevEntry.endMs + options.defaultGapMs;
        if (atTag.value < minStartMs) {
          diagnostics.push({
            code: "TIMELINE_REFLOWED",
            severity: "warning",
            nodeId: node.nodeId,
            message: `Flow mode reflowed ${node.nodeId} from ${atTag.value}ms to ${minStartMs}ms.`,
          });
          startMs = minStartMs;
        } else {
          startMs = atTag.value;
        }
      }
    } else {
      startMs = prevEntry.endMs + options.defaultGapMs;
    }

    const endMs = startMs + durationMs;
    if (
      !isValidTimelineInterval(startMs, endMs) ||
      (prevEntry &&
        options.timingMode !== "strict" &&
        startMs < prevEntry.endMs)
    ) {
      diagnostics.push({
        code: "TIMELINE_INTERVAL_OVERFLOW",
        severity: "error",
        nodeId: node.nodeId,
        message: `Resolved timeline interval [${startMs}, ${endMs}] for ${node.nodeId} is non-finite, non-advancing, or exceeds MAX_SAFE_INTEGER.`,
      });
      continue;
    }

    visitedNodes.add(node.nodeId);

    const entryIndex = entries.length;
    const entry = buildEntryFromNode(
      node,
      entryIndex,
      startMs,
      durationMs,
      clipDef,
      isRevisit,
      diagnostics,
      true,
    );
    if (!isRevisit) {
      cueDiagnosticsEmitted.add(node.nodeId);
    }
    entries.push(entry);

    let list = timelineIndicesByNode.get(node.nodeId);
    if (!list) {
      list = [];
      timelineIndicesByNode.set(node.nodeId, list);
    }
    list.push(entryIndex);
  }

  // Build nodeIndex for all nodes
  const nodeIndex: Record<string, NodeIndexEntry> = {};
  for (const node of allNodes) {
    const clipDef =
      node.tags.audioClipId !== null ? (resolvedClips.get(node.tags.audioClipId) ?? null) : null;
    const indices = timelineIndicesByNode.get(node.nodeId) ?? [];
    const indexEntry: NodeIndexEntry = {
      gameIndex: node.gameIndex,
      fen: node.fen,
      lastMove: node.lastMove ? { ...node.lastMove } : null,
      orientation: node.orientation,
      clipId: node.tags.audioClipId,
      comment: node.tags.prose,
      arrows: cloneArrows(node.tags.arrows),
      highlights: cloneHighlights(node.tags.highlights),
      timelineIndex: indices[0] ?? null,
      timelineIndices: [...indices],
    };
    if (clipDef?.subtitles) {
      indexEntry.subtitles = { ...clipDef.subtitles };
    }
    nodeIndex[node.nodeId] = indexEntry;
  }

  // Compile [%guess] specs
  const guesses: Record<string, GuessSpec> = {};
  for (const node of allNodes) {
    if (!node.tags.guess) continue;

    const branches: GuessBranch[] = [];
    for (let childIdx = 0; childIdx < node.children.length; childIdx++) {
      const child = node.children[childIdx]!;
      if (!child.san || !child.lastMove) continue;

      const isMainline = child.siblingIndex === 0;
      const outcome = classifyGuessOutcome(child, isMainline);
      const mainTimelineIndex = nodeIndex[child.nodeId]?.timelineIndex ?? null;

      // Compile branchTimeline starting at 0ms spaced by defaultGapMs
      const branchTimeline: TimelineEntry[] = [];
      let cur: CompiledNode | undefined = child;
      let stepIdx = 0;
      let cursorMs = 0;

      while (cur) {
        if (stepIdx > 0 && cur.tags.guess !== null) {
          break;
        }
        if (isMainline && stepIdx > 0 && cur.tags.atTags.length > 0) {
          break;
        }

        const stepClip =
          cur.tags.audioClipId !== null ? (resolvedClips.get(cur.tags.audioClipId) ?? null) : null;
        const stepDurationMs = stepClip
          ? stepClip.trimEndMs - stepClip.trimStartMs
          : (getPrimaryAtTagDurMs(cur) ?? cur.tags.durMs ?? options.defaultSilentDurationMs);

        if (!Number.isFinite(stepDurationMs) || stepDurationMs <= 0) {
          diagnostics.push({
            code: "ZERO_ENTRY_DURATION",
            severity: "error",
            nodeId: cur.nodeId,
            message: `Branch step ${cur.nodeId} has non-positive duration ${stepDurationMs}ms.`,
          });
          break;
        }

        const stepEndMs = cursorMs + stepDurationMs;
        const prevBranchStep = branchTimeline[branchTimeline.length - 1];
        if (
          !isValidTimelineInterval(cursorMs, stepEndMs) ||
          (prevBranchStep && cursorMs < prevBranchStep.endMs)
        ) {
          diagnostics.push({
            code: "TIMELINE_INTERVAL_OVERFLOW",
            severity: "error",
            nodeId: cur.nodeId,
            message: `Branch timeline interval [${cursorMs}, ${stepEndMs}] for ${cur.nodeId} is non-finite, non-advancing, or exceeds MAX_SAFE_INTEGER.`,
          });
          break;
        }

        const emitCueDiags = !cueDiagnosticsEmitted.has(cur.nodeId);
        const branchEntry = buildEntryFromNode(
          cur,
          branchTimeline.length,
          cursorMs,
          stepDurationMs,
          stepClip,
          false,
          diagnostics,
          emitCueDiags,
        );
        cueDiagnosticsEmitted.add(cur.nodeId);
        branchTimeline.push(branchEntry);
        cursorMs = branchEntry.endMs + options.defaultGapMs;
        cur = cur.children.find((c) => c.siblingIndex === 0);
        stepIdx++;
      }

      const lastStep = branchTimeline[branchTimeline.length - 1];
      const branchDurationMs = lastStep ? lastStep.endMs : 0;

      branches.push({
        nodeId: child.nodeId,
        san: child.san,
        from: child.lastMove.from,
        to: child.lastMove.to,
        outcome,
        nags: [...child.nags],
        isMainline,
        mainTimelineIndex,
        branchTimeline,
        branchDurationMs,
      });
    }

    const spec: GuessSpec = {
      promptNodeId: node.nodeId,
      returnPolicy: node.tags.guess.returnPolicy,
      branches,
    };
    guesses[node.nodeId] = spec;

    // Attach to primary scheduled TimelineEntry if present
    const primaryTimelineIdx = nodeIndex[node.nodeId]?.timelineIndex;
    if (primaryTimelineIdx !== null && primaryTimelineIdx !== undefined) {
      const targetEntry = entries[primaryTimelineIdx];
      if (targetEntry && !targetEntry.isRevisit) {
        targetEntry.guess = spec;
      }
    }
  }

  // Merge WebVTT subtitles using prototype-safe lookup record
  const { mergedSubtitlesPaths, mergedSubtitlesVtt } = mergeTimelineSubtitles(
    entries,
    toNullProtoStringRecord(input.subtitlesByPath),
  );

  const lastEntry = entries[entries.length - 1];
  const totalDurationMs = lastEntry ? lastEntry.endMs : 0;

  const timeline: PgnaTimeline = {
    format: "pgna-timeline",
    version: PGNA_FORMAT_VERSION,
    compiledAt: input.compiledAt ?? new Date().toISOString(),
    totalDurationMs,
    games: gamesMeta,
    ...(Object.keys(mergedSubtitlesPaths).length > 0
      ? { mergedSubtitles: mergedSubtitlesPaths }
      : {}),
    entries,
    nodeIndex,
    ...(Object.keys(guesses).length > 0 ? { guesses } : {}),
  };

  return {
    timeline,
    mergedSubtitlesVtt,
    diagnostics,
  };
}
