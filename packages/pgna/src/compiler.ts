import { ChessPosition, INITIAL_FEN, parsePgnGames, validateFen, type PgnMoveNode } from "@suite/chess-core";
import { applyCueDirectives, parseNodeComments } from "./tags.js";
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
import { isSafeArchivePath, isValidClipId } from "./validator.js";
import { mergeTimelineSubtitles } from "./vtt.js";

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
  const timingModeRaw = raw?.timingMode ?? "flow";
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

  const defaultSilentRaw = raw?.defaultSilentDurationMs ?? DEFAULT_SILENT_DURATION_MS;
  let defaultSilentDurationMs: number = DEFAULT_SILENT_DURATION_MS;
  if (typeof defaultSilentRaw === "number" && Number.isFinite(defaultSilentRaw) && defaultSilentRaw > 0) {
    defaultSilentDurationMs = defaultSilentRaw;
  } else {
    diagnostics.push({
      code: "INVALID_COMPILATION_OPTIONS",
      severity: "error",
      message: `Invalid compilation.defaultSilentDurationMs "${String(defaultSilentRaw)}": must be a finite number > 0.`,
    });
  }

  const defaultReturnRaw = raw?.defaultReturnPauseMs ?? DEFAULT_RETURN_PAUSE_MS;
  let defaultReturnPauseMs: number = DEFAULT_RETURN_PAUSE_MS;
  if (typeof defaultReturnRaw === "number" && Number.isFinite(defaultReturnRaw) && defaultReturnRaw > 0) {
    defaultReturnPauseMs = defaultReturnRaw;
  } else {
    diagnostics.push({
      code: "INVALID_COMPILATION_OPTIONS",
      severity: "error",
      message: `Invalid compilation.defaultReturnPauseMs "${String(defaultReturnRaw)}": must be a finite number > 0.`,
    });
  }

  const defaultGapRaw = raw?.defaultGapMs ?? DEFAULT_GAP_MS;
  let defaultGapMs: number = DEFAULT_GAP_MS;
  if (typeof defaultGapRaw === "number" && Number.isFinite(defaultGapRaw) && defaultGapRaw >= 0) {
    defaultGapMs = defaultGapRaw;
  } else {
    diagnostics.push({
      code: "INVALID_COMPILATION_OPTIONS",
      severity: "error",
      message: `Invalid compilation.defaultGapMs "${String(defaultGapRaw)}": must be a finite number >= 0.`,
    });
  }

  const includeUnscheduledRaw = raw?.includeUnscheduledAudio ?? false;
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
  if (!isSafeArchivePath(manifest.pgnPath)) {
    diagnostics.push({
      code: "UNSAFE_ARCHIVE_PATH",
      severity: "error",
      path: manifest.pgnPath,
      message: `Unsafe manifest.pgnPath "${manifest.pgnPath}".`,
    });
  }
  if (!isSafeArchivePath(manifest.timelinePath)) {
    diagnostics.push({
      code: "UNSAFE_ARCHIVE_PATH",
      severity: "error",
      path: manifest.timelinePath,
      message: `Unsafe manifest.timelinePath "${manifest.timelinePath}".`,
    });
  }

  const resolvedClips = new Map<string, ResolvedClipAudio & { subtitles?: Record<string, string> }>();
  const clips: Record<string, ClipDefinition> = manifest.clips ?? {};

  for (const [clipId, clip] of Object.entries(clips)) {
    if (!isValidClipId(clipId)) {
      diagnostics.push({
        code: "INVALID_CLIP_ID",
        severity: "error",
        message: `Invalid clip ID "${clipId}" in manifest.clips.`,
      });
      continue;
    }
    if (clip.id !== clipId) {
      diagnostics.push({
        code: "CLIP_ID_MISMATCH",
        severity: "error",
        message: `Clip "${clipId}" has mismatched inner id "${clip.id}".`,
      });
    }
    if (!isSafeArchivePath(clip.path)) {
      diagnostics.push({
        code: "UNSAFE_ARCHIVE_PATH",
        severity: "error",
        path: clip.path,
        message: `Unsafe clip path "${clip.path}" for clip "${clipId}".`,
      });
    }
    if (clip.subtitles) {
      for (const subPath of Object.values(clip.subtitles)) {
        if (!isSafeArchivePath(subPath)) {
          diagnostics.push({
            code: "UNSAFE_ARCHIVE_PATH",
            severity: "error",
            path: subPath,
            message: `Unsafe subtitle path "${subPath}" for clip "${clipId}".`,
          });
        }
      }
    }

    if (typeof clip.durationMs !== "number" || !Number.isFinite(clip.durationMs) || clip.durationMs <= 0) {
      diagnostics.push({
        code: "INVALID_CLIP_DURATION",
        severity: "error",
        path: clip.path,
        message: `Clip "${clipId}" durationMs must be a finite number > 0.`,
      });
      continue;
    }

    const trimStartMs = clip.trimStartMs ?? 0;
    const trimEndMs = clip.trimEndMs ?? clip.durationMs;
    if (
      !Number.isFinite(trimStartMs) ||
      !Number.isFinite(trimEndMs) ||
      trimStartMs < 0 ||
      trimEndMs <= trimStartMs ||
      trimEndMs > clip.durationMs
    ) {
      diagnostics.push({
        code: "INVALID_CLIP_TRIM",
        severity: "error",
        path: clip.path,
        message: `Clip "${clipId}" has invalid trim bounds [${trimStartMs}, ${trimEndMs}] for durationMs ${clip.durationMs}.`,
      });
      continue;
    }

    resolvedClips.set(clipId, {
      clipId,
      path: clip.path,
      mimeType: clip.mimeType,
      durationMs: clip.durationMs,
      trimStartMs,
      trimEndMs,
      ...(clip.subtitles && Object.keys(clip.subtitles).length > 0
        ? { subtitles: { ...clip.subtitles } }
        : {}),
    });
  }

  return resolvedClips;
}

function resolveGameOrientation(headers: Record<string, string>): BoardOrientation {
  const raw = headers["Orientation"]?.trim().toLowerCase();
  return raw === "black" ? "black" : "white";
}

function makeChildNodeId(parentId: NodeId, childIndex: number): NodeId {
  if (parentId.includes("/")) {
    return `${parentId}.${childIndex}` as NodeId;
  }
  return `${parentId}/${childIndex}` as NodeId;
}

function compileCuesForEntry(
  node: CompiledNode,
  entryStartMs: number,
  trimStartMs: number,
  trimEndMs: number,
  isRevisit: boolean,
  diagnostics: PgnaDiagnostic[],
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
      diagnostics.push({
        code: "CUE_OUT_OF_BOUNDS",
        severity: "warning",
        nodeId: node.nodeId,
        message: `Cue at ${cue.offsetMs}ms on node ${node.nodeId} falls at or beyond trimEndMs (${trimEndMs}ms) and was omitted.`,
      });
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

function buildEntryFromNode(
  node: CompiledNode,
  index: number,
  startMs: number,
  durationMs: number,
  resolvedClip: (ResolvedClipAudio & { subtitles?: Record<string, string> }) | null,
  isRevisit: boolean,
  diagnostics: PgnaDiagnostic[],
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

  const cues = compileCuesForEntry(node, startMs, trimStartMs, trimEndMs, isRevisit, diagnostics);

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

  // Walk games in exact PGN document order:
  // For a list of siblings [M, RAV1, RAV2, ...]:
  //   1. Visit M (document order)
  //   2. Visit each RAV_k subtree in order (they appear immediately after M in PGN text)
  //   3. Visit M's children
  const walkSiblings = (
    pgnSiblings: readonly PgnMoveNode[],
    parentNode: CompiledNode,
    gameOrientation: BoardOrientation,
  ): void => {
    if (pgnSiblings.length === 0) return;

    const compiledSiblings: Array<{ pgn: PgnMoveNode; compiled: CompiledNode | null }> = [];

    // First instantiate M (child 0) so it gets documentOrder before its sibling RAVs
    const createCompiledChild = (
      pgnNode: PgnMoveNode,
      childIndex: number,
    ): CompiledNode | null => {
      const nodeId = makeChildNodeId(parentNode.nodeId, childIndex);
      const pos = new ChessPosition(parentNode.fen);
      const applied = pos.tryMove(pgnNode.san);
      if (!applied) {
        diagnostics.push({
          code: "ILLEGAL_MOVE",
          severity: "error",
          nodeId,
          message: `Illegal move "${pgnNode.san}" at ${nodeId} from FEN "${parentNode.fen}".`,
        });
        return null;
      }

      const { tags, diagnostics: tagDiags } = parseNodeComments(pgnNode.comments, nodeId);
      diagnostics.push(...tagDiags);

      const compiled: CompiledNode = {
        nodeId,
        gameIndex: parentNode.gameIndex,
        ply: parentNode.ply + 1,
        san: applied.san,
        fen: applied.fen,
        lastMove: { from: applied.from, to: applied.to },
        orientation: tags.orientation ?? gameOrientation,
        nags: [...pgnNode.nags],
        tags,
        documentOrder: docOrderCounter++,
        children: [],
      };

      parentNode.children.push(compiled);
      allNodes.push(compiled);
      nodeById.set(nodeId, compiled);
      return compiled;
    };

    // 1. Primary move M (child 0)
    const primaryPgn = pgnSiblings[0]!;
    const primaryCompiled = createCompiledChild(primaryPgn, 0);
    compiledSiblings.push({ pgn: primaryPgn, compiled: primaryCompiled });

    // 2. Sibling RAVs (children 1..k) appear in PGN text right after M, before M's continuation
    for (let i = 1; i < pgnSiblings.length; i++) {
      const ravPgn = pgnSiblings[i]!;
      const ravCompiled = createCompiledChild(ravPgn, i);
      if (ravCompiled) {
        walkSiblings(ravPgn.children, ravCompiled, gameOrientation);
      }
    }

    // 3. Mainline continuation of M
    if (primaryCompiled) {
      walkSiblings(primaryPgn.children, primaryCompiled, gameOrientation);
    }
  };

  for (let gameIndex = 0; gameIndex < parsedGames.length; gameIndex++) {
    const game = parsedGames[gameIndex]!;
    const rawFen = game.headers["FEN"]?.trim();
    const initialFen = rawFen && rawFen.length > 0 ? rawFen : INITIAL_FEN;
    const gameOrientation = resolveGameOrientation(game.headers);

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
      children: [],
    };

    allNodes.push(rootNode);
    nodeById.set(rootNodeId, rootNode);

    walkSiblings(game.rootMoves, rootNode, gameOrientation);
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
    const aVal = a.atTag!.value;
    const bVal = b.atTag!.value;
    if (aVal !== bVal) return aVal - bVal;
    if (a.node.documentOrder !== b.node.documentOrder) {
      return a.node.documentOrder - b.node.documentOrder;
    }
    return a.tagIndexOnNode - b.tagIndexOnNode;
  });

  const allOccurrences = [...scheduledOccurrences, ...unscheduledAudioOccurrences];

  // Build main timeline entries
  const entries: TimelineEntry[] = [];
  const visitedNodes = new Set<NodeId>();
  const timelineIndicesByNode = new Map<NodeId, number[]>();

  for (const occ of allOccurrences) {
    const { node, atTag } = occ;
    const isRevisit = visitedNodes.has(node.nodeId);
    visitedNodes.add(node.nodeId);

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

    if (durationMs <= 0) {
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

    const entryIndex = entries.length;
    const entry = buildEntryFromNode(
      node,
      entryIndex,
      startMs,
      durationMs,
      clipDef,
      isRevisit,
      diagnostics,
    );
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

      const isMainline = childIdx === 0;
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
          : (cur.tags.durMs ?? options.defaultSilentDurationMs);

        if (stepDurationMs <= 0) {
          diagnostics.push({
            code: "ZERO_ENTRY_DURATION",
            severity: "error",
            nodeId: cur.nodeId,
            message: `Branch step ${cur.nodeId} has non-positive duration ${stepDurationMs}ms.`,
          });
          break;
        }

        const branchEntry = buildEntryFromNode(
          cur,
          branchTimeline.length,
          cursorMs,
          stepDurationMs,
          stepClip,
          false,
          diagnostics,
        );
        branchTimeline.push(branchEntry);
        cursorMs = branchEntry.endMs + options.defaultGapMs;
        cur = cur.children[0];
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

  // Merge WebVTT subtitles
  const { mergedSubtitlesPaths, mergedSubtitlesVtt } = mergeTimelineSubtitles(
    entries,
    input.subtitlesByPath ?? {},
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
