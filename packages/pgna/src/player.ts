import { ChessPosition, INITIAL_FEN } from "@suite/chess-core";
import type {
  ArrowAnnotation,
  BoardOrientation,
  ClipDefinition,
  CueSnapshot,
  GuessBranch,
  GuessOutcome,
  GuessSpec,
  LastMoveCoords,
  NodeId,
  PgnaTimeline,
  ResolvedClipAudio,
  SquareHighlight,
  TimelineEntry,
  WebVttCue,
} from "./types.js";
import { findActiveSubtitleText, parseWebVtt } from "./vtt.js";

export type PlaybackMode = "timeline" | "manual";
export type GuessSessionPhase = "idle" | "awaiting" | "playing_branch" | "branch_complete";

export interface GuessEvaluationResult {
  status: "unlisted" | GuessOutcome;
  matchedBranchNodeId: NodeId | null;
}

export interface PlaybackSnapshot {
  mode: PlaybackMode;
  isPlaying: boolean;
  globalTimeMs: number;
  totalDurationMs: number;
  activeEntryIndex: number | null;
  activeNodeId: NodeId | null;
  isRevisit: boolean;
  fen: string;
  lastMove: LastMoveCoords | null;
  orientation: BoardOrientation;
  comment: string;
  arrows: ArrowAnnotation[];
  highlights: SquareHighlight[];
  activeAudio: ResolvedClipAudio | null;
  /** Playback offset inside the active audio clip (in ms), or null when silent. */
  audioTimeMs: number | null;
  activeSubtitle: string | null;
  guessPhase: GuessSessionPhase;
  activeGuess: GuessSpec | null;
  activeBranch: GuessBranch | null;
  lastGuessResult: GuessEvaluationResult | null;
  branchTimeMs: number;
  branchDurationMs: number;
}

export interface CreatePgnaPlayerOptions {
  /** Whether `[%guess]` prompts automatically pause timeline playback (default true). */
  interactiveGuessesEnabled?: boolean;
  /** Optional subtitle language code (e.g. "en") to resolve activeSubtitle. */
  subtitleLang?: string;
  /** Optional map of archive path -> raw WebVTT text (including merged `subtitles/<lang>/timeline.vtt` and per-clip `.vtt`). */
  subtitlesByPath?: Record<string, string>;
  /** Optional clip definitions for playing unscheduled audio clips in Manual Mode. */
  clips?: Record<string, ClipDefinition>;
}

export interface PgnaPlayerController {
  getSnapshot(): PlaybackSnapshot;
  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void;
  setMode(mode: PlaybackMode): void;
  play(): void;
  pause(): void;
  tick(deltaMs: number): PlaybackSnapshot;
  seek(globalTimeMs: number): void;
  selectNode(nodeId: NodeId): void;
  jumpToNodeOnTimeline(nodeId: NodeId, occurrenceIndex?: number): boolean;
  setManualClipTime(clipTimeMs: number): void;
  setSubtitleLang(lang: string | null): void;
  setInteractiveGuessesEnabled(enabled: boolean): void;
  enterGuessPrompt(nodeId: NodeId): boolean;
  submitGuessMove(
    from: string,
    to: string,
    promotion?: "q" | "r" | "b" | "n",
  ): GuessEvaluationResult;
  returnToGuess(): void;
  replayGuessBranch(): void;
  continueAfterGuess(): void;
  resetResolvedGuesses(): void;
}

function binarySearchEntryIndex(entries: readonly TimelineEntry[], timeMs: number): number {
  let lo = 0;
  let hi = entries.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const entry = entries[mid]!;
    if (entry.startMs <= timeMs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function binarySearchCue(cues: readonly CueSnapshot[], offsetMs: number): CueSnapshot | null {
  if (cues.length === 0) return null;
  let lo = 0;
  let hi = cues.length - 1;
  let best = cues[0]!;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cue = cues[mid]!;
    if (cue.offsetMs <= offsetMs) {
      best = cue;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function resolveEntrySlice(
  entries: readonly TimelineEntry[],
  timeMs: number,
): { entry: TimelineEntry | null; isActive: boolean; cue: CueSnapshot | null } {
  if (entries.length === 0) {
    return { entry: null, isActive: false, cue: null };
  }

  const first = entries[0]!;
  if (timeMs < first.startMs) {
    return {
      entry: first,
      isActive: false,
      cue: first.cues[0] ?? null,
    };
  }

  const idx = binarySearchEntryIndex(entries, timeMs);
  if (idx === -1) {
    return { entry: first, isActive: false, cue: first.cues[0] ?? null };
  }

  const candidate = entries[idx]!;
  if (timeMs >= candidate.startMs && timeMs < candidate.endMs) {
    const relOffset = timeMs - candidate.startMs;
    return {
      entry: candidate,
      isActive: true,
      cue: binarySearchCue(candidate.cues, relOffset),
    };
  }

  // Gap between candidate.endMs and next entry, or past end of timeline: hold final state silently
  const finalCue = candidate.cues[candidate.cues.length - 1] ?? null;
  return {
    entry: candidate,
    isActive: false,
    cue: finalCue,
  };
}

/**
 * Dual-mode PGNA v1.0 playback state machine supporting:
 * - Timeline Auto-Play Mode (§8.1) including silent moves and silent node revisits
 * - Manual Chess Mode (§8.2)
 * - Interactive `[%guess]` prompt & branch playback contract (§8.3)
 */
export function createPgnaPlayer(
  timeline: PgnaTimeline,
  options: CreatePgnaPlayerOptions = {},
): PgnaPlayerController {
  let mode: PlaybackMode = "timeline";
  let isPlaying = false;
  let globalTimeMs = 0;
  let manualNodeId: NodeId | null =
    timeline.entries[0]?.nodeId ??
    (timeline.games[0] ? (`g${timeline.games[0].gameIndex}` as NodeId) : null);
  let manualClipTimeMs = 0;
  let interactiveGuessesEnabled = options.interactiveGuessesEnabled ?? true;
  let subtitleLang: string | null =
    options.subtitleLang ?? Object.keys(timeline.mergedSubtitles ?? {})[0] ?? null;

  // Interactive guess session state
  let guessPhase: GuessSessionPhase = "idle";
  let activeGuess: GuessSpec | null = null;
  let activeGuessPromptTimelineIndex: number | null = null;
  let activeBranch: GuessBranch | null = null;
  let lastGuessResult: GuessEvaluationResult | null = null;
  let branchTimeMs = 0;
  const resolvedPromptIds = new Set<string>();

  const listeners = new Set<(snapshot: PlaybackSnapshot) => void>();

  // Pre-parse WebVTT tracks for fast zero-alloc lookups
  const parsedVttByPath = new Map<string, WebVttCue[]>();
  if (options.subtitlesByPath) {
    for (const [path, raw] of Object.entries(options.subtitlesByPath)) {
      parsedVttByPath.set(path, parseWebVtt(raw));
    }
  }

  const resolveClipSubtitle = (
    subtitles: Record<string, string> | undefined,
    clipTimeMs: number,
  ): string | null => {
    if (!subtitleLang || !subtitles) return null;
    const subPath = subtitles[subtitleLang];
    if (!subPath) return null;
    const cues = parsedVttByPath.get(subPath);
    if (!cues) return null;
    return findActiveSubtitleText(cues, clipTimeMs);
  };

  const resolveMergedTimelineSubtitle = (timeMs: number): string | null => {
    if (!subtitleLang || !timeline.mergedSubtitles) return null;
    const mergedPath = timeline.mergedSubtitles[subtitleLang];
    if (!mergedPath) return null;
    const cues = parsedVttByPath.get(mergedPath);
    if (!cues) return null;
    return findActiveSubtitleText(cues, timeMs);
  };

  const resolveManualAudio = (nodeId: NodeId): ResolvedClipAudio | null => {
    const idxEntry = timeline.nodeIndex[nodeId];
    if (!idxEntry) return null;

    if (idxEntry.timelineIndex !== null) {
      const primary = timeline.entries[idxEntry.timelineIndex];
      if (primary?.audio) return primary.audio;
    }

    if (idxEntry.clipId && options.clips?.[idxEntry.clipId]) {
      const def = options.clips[idxEntry.clipId]!;
      return {
        clipId: def.id,
        path: def.path,
        mimeType: def.mimeType,
        durationMs: def.durationMs,
        trimStartMs: def.trimStartMs ?? 0,
        trimEndMs: def.trimEndMs ?? def.durationMs,
      };
    }

    return null;
  };

  const getSnapshot = (): PlaybackSnapshot => {
    // 1. Active branch playback or branch_complete during an interactive [%guess] session
    if ((guessPhase === "playing_branch" || guessPhase === "branch_complete") && activeBranch) {
      const slice = resolveEntrySlice(activeBranch.branchTimeline, branchTimeMs);
      const entry = slice.entry;
      const hasAudio = Boolean(slice.isActive && entry?.audio && !entry.isRevisit);
      const audioTimeMs =
        hasAudio && entry?.audio
          ? Math.min(entry.audio.trimEndMs, entry.audio.trimStartMs + (branchTimeMs - entry.startMs))
          : null;
      const activeSubtitle =
        hasAudio && entry && audioTimeMs !== null
          ? resolveClipSubtitle(entry.subtitles, audioTimeMs)
          : null;

      return {
        mode,
        isPlaying,
        globalTimeMs,
        totalDurationMs: timeline.totalDurationMs,
        activeEntryIndex: activeGuessPromptTimelineIndex,
        activeNodeId: entry?.nodeId ?? activeBranch.nodeId,
        isRevisit: false,
        fen: entry?.fen ?? INITIAL_FEN,
        lastMove: entry?.lastMove ?? null,
        orientation: entry?.orientation ?? "white",
        comment: entry?.comment ?? "",
        arrows: slice.cue?.arrows ?? [],
        highlights: slice.cue?.highlights ?? [],
        activeAudio: hasAudio ? (entry?.audio ?? null) : null,
        audioTimeMs,
        activeSubtitle,
        guessPhase,
        activeGuess,
        activeBranch,
        lastGuessResult,
        branchTimeMs,
        branchDurationMs: activeBranch.branchDurationMs,
      };
    }

    // 2. Awaiting guess on a prompt node
    if (guessPhase === "awaiting" && activeGuess) {
      const promptNode = timeline.nodeIndex[activeGuess.promptNodeId];
      const promptEntry =
        activeGuessPromptTimelineIndex !== null
          ? timeline.entries[activeGuessPromptTimelineIndex]
          : promptNode?.timelineIndex !== null && promptNode?.timelineIndex !== undefined
            ? timeline.entries[promptNode.timelineIndex]
            : null;
      const finalCue = promptEntry ? (promptEntry.cues[promptEntry.cues.length - 1] ?? null) : null;

      return {
        mode,
        isPlaying: false,
        globalTimeMs,
        totalDurationMs: timeline.totalDurationMs,
        activeEntryIndex: activeGuessPromptTimelineIndex,
        activeNodeId: activeGuess.promptNodeId,
        isRevisit: false,
        fen: promptNode?.fen ?? promptEntry?.fen ?? INITIAL_FEN,
        lastMove: promptNode?.lastMove ?? promptEntry?.lastMove ?? null,
        orientation: promptNode?.orientation ?? promptEntry?.orientation ?? "white",
        comment: promptEntry?.comment ?? "",
        arrows: finalCue?.arrows ?? [],
        highlights: finalCue?.highlights ?? [],
        activeAudio: null,
        audioTimeMs: null,
        activeSubtitle: null,
        guessPhase,
        activeGuess,
        activeBranch: null,
        lastGuessResult,
        branchTimeMs: 0,
        branchDurationMs: 0,
      };
    }

    // 3. Manual Chess Mode (§8.2)
    if (mode === "manual") {
      const nodeId = manualNodeId;
      const nodeEntry = nodeId ? timeline.nodeIndex[nodeId] : undefined;
      const primaryEntry =
        nodeEntry?.timelineIndex !== null && nodeEntry?.timelineIndex !== undefined
          ? timeline.entries[nodeEntry.timelineIndex]
          : undefined;
      const audio = nodeId ? resolveManualAudio(nodeId) : null;
      const relOffset = audio ? Math.max(0, manualClipTimeMs - audio.trimStartMs) : 0;
      const cue = primaryEntry ? binarySearchCue(primaryEntry.cues, relOffset) : null;
      const isWithinClip =
        audio !== null && isPlaying && manualClipTimeMs >= audio.trimStartMs && manualClipTimeMs < audio.trimEndMs;
      const activeSubtitle =
        isWithinClip && audio
          ? resolveClipSubtitle(nodeEntry?.subtitles ?? primaryEntry?.subtitles, manualClipTimeMs)
          : null;

      return {
        mode,
        isPlaying: isWithinClip,
        globalTimeMs,
        totalDurationMs: timeline.totalDurationMs,
        activeEntryIndex: nodeEntry?.timelineIndex ?? null,
        activeNodeId: nodeId,
        isRevisit: false,
        fen: nodeEntry?.fen ?? timeline.games[0]?.initialFen ?? INITIAL_FEN,
        lastMove: nodeEntry?.lastMove ?? null,
        orientation: nodeEntry?.orientation ?? timeline.games[0]?.orientation ?? "white",
        comment: primaryEntry?.comment ?? "",
        arrows: cue?.arrows ?? [],
        highlights: cue?.highlights ?? [],
        activeAudio: isWithinClip ? audio : null,
        audioTimeMs: isWithinClip ? manualClipTimeMs : null,
        activeSubtitle,
        guessPhase,
        activeGuess,
        activeBranch,
        lastGuessResult,
        branchTimeMs: 0,
        branchDurationMs: 0,
      };
    }

    // 4. Timeline Auto-Play Mode (§8.1)
    const slice = resolveEntrySlice(timeline.entries, globalTimeMs);
    const entry = slice.entry;
    const isRevisit = Boolean(entry?.isRevisit);
    const hasAudio = Boolean(slice.isActive && entry?.audio && !isRevisit);
    const audioTimeMs =
      hasAudio && entry?.audio
        ? Math.min(entry.audio.trimEndMs, entry.audio.trimStartMs + (globalTimeMs - entry.startMs))
        : null;

    let activeSubtitle: string | null = null;
    if (hasAudio && entry && audioTimeMs !== null) {
      const mergedPath = subtitleLang ? timeline.mergedSubtitles?.[subtitleLang] : undefined;
      if (mergedPath && parsedVttByPath.has(mergedPath)) {
        activeSubtitle = resolveMergedTimelineSubtitle(globalTimeMs);
      } else {
        activeSubtitle = resolveClipSubtitle(entry.subtitles, audioTimeMs);
      }
    }

    return {
      mode,
      isPlaying,
      globalTimeMs,
      totalDurationMs: timeline.totalDurationMs,
      activeEntryIndex: entry?.index ?? null,
      activeNodeId: entry?.nodeId ?? (timeline.games[0] ? (`g${timeline.games[0].gameIndex}` as NodeId) : null),
      isRevisit,
      fen: entry?.fen ?? timeline.games[0]?.initialFen ?? INITIAL_FEN,
      lastMove: entry?.lastMove ?? null,
      orientation: entry?.orientation ?? timeline.games[0]?.orientation ?? "white",
      comment: entry?.comment ?? "",
      arrows: slice.cue?.arrows ?? [],
      highlights: slice.cue?.highlights ?? [],
      activeAudio: hasAudio ? (entry?.audio ?? null) : null,
      audioTimeMs,
      activeSubtitle,
      guessPhase,
      activeGuess,
      activeBranch,
      lastGuessResult,
      branchTimeMs: 0,
      branchDurationMs: 0,
    };
  };

  const notify = () => {
    const snap = getSnapshot();
    for (const listener of listeners) {
      listener(snap);
    }
  };

  const clearGuessSession = () => {
    guessPhase = "idle";
    activeGuess = null;
    activeGuessPromptTimelineIndex = null;
    activeBranch = null;
    lastGuessResult = null;
    branchTimeMs = 0;
  };

  return {
    getSnapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setMode(nextMode) {
      if (mode === nextMode) return;
      mode = nextMode;
      isPlaying = false;
      clearGuessSession();
      if (nextMode === "manual") {
        const slice = resolveEntrySlice(timeline.entries, globalTimeMs);
        if (slice.entry) {
          manualNodeId = slice.entry.nodeId;
        }
      }
      notify();
    },

    play() {
      if (guessPhase === "awaiting" || guessPhase === "branch_complete") {
        return;
      }
      if (mode === "timeline" && guessPhase === "idle") {
        if (globalTimeMs >= timeline.totalDurationMs && timeline.totalDurationMs > 0) {
          globalTimeMs = 0;
        }
      } else if (mode === "manual" && manualNodeId) {
        const audio = resolveManualAudio(manualNodeId);
        if (!audio) {
          isPlaying = false;
          notify();
          return;
        }
        if (manualClipTimeMs < audio.trimStartMs || manualClipTimeMs >= audio.trimEndMs) {
          manualClipTimeMs = audio.trimStartMs;
        }
      }
      isPlaying = true;
      notify();
    },

    pause() {
      if (!isPlaying) return;
      isPlaying = false;
      notify();
    },

    tick(deltaMs) {
      if (!Number.isFinite(deltaMs)) {
        return getSnapshot();
      }
      const dt = Math.max(0, deltaMs);
      if (!isPlaying || dt === 0) {
        return getSnapshot();
      }

      // Playing a guess branch
      if (guessPhase === "playing_branch" && activeBranch && activeGuess) {
        branchTimeMs = Math.min(activeBranch.branchDurationMs, branchTimeMs + dt);
        if (branchTimeMs >= activeBranch.branchDurationMs) {
          isPlaying = false;
          if (activeGuess.returnPolicy === "auto" && activeBranch.outcome !== "success") {
            guessPhase = "awaiting";
            activeBranch = null;
            branchTimeMs = 0;
          } else {
            guessPhase = "branch_complete";
          }
        }
        const snap = getSnapshot();
        for (const l of listeners) l(snap);
        return snap;
      }

      // Manual mode clip playback
      if (mode === "manual") {
        if (manualNodeId) {
          const audio = resolveManualAudio(manualNodeId);
          if (audio) {
            manualClipTimeMs = Math.min(audio.trimEndMs, manualClipTimeMs + dt);
            if (manualClipTimeMs >= audio.trimEndMs) {
              isPlaying = false;
            }
          } else {
            isPlaying = false;
          }
        } else {
          isPlaying = false;
        }
        const snap = getSnapshot();
        for (const l of listeners) l(snap);
        return snap;
      }

      // Timeline Auto-Play Mode (§8.1 + §8.3 guess triggering)
      const prevTime = globalTimeMs;
      const targetTime = Math.min(timeline.totalDurationMs, prevTime + dt);

      if (interactiveGuessesEnabled) {
        for (const entry of timeline.entries) {
          if (
            entry.guess &&
            entry.guess.branches.length > 0 &&
            !resolvedPromptIds.has(entry.nodeId) &&
            entry.endMs > prevTime &&
            entry.endMs <= targetTime
          ) {
            globalTimeMs = entry.endMs;
            isPlaying = false;
            guessPhase = "awaiting";
            activeGuess = entry.guess;
            activeGuessPromptTimelineIndex = entry.index;
            activeBranch = null;
            lastGuessResult = null;
            branchTimeMs = 0;
            const snap = getSnapshot();
            for (const l of listeners) l(snap);
            return snap;
          }
        }
      }

      globalTimeMs = targetTime;
      if (globalTimeMs >= timeline.totalDurationMs) {
        isPlaying = false;
      }

      const snap = getSnapshot();
      for (const l of listeners) l(snap);
      return snap;
    },

    seek(nextTimeMs) {
      if (!Number.isFinite(nextTimeMs)) {
        return;
      }
      clearGuessSession();
      globalTimeMs = Math.max(0, Math.min(nextTimeMs, timeline.totalDurationMs));
      notify();
    },

    selectNode(nodeId) {
      clearGuessSession();
      mode = "manual";
      isPlaying = false;
      manualNodeId = nodeId;
      const audio = resolveManualAudio(nodeId);
      manualClipTimeMs = audio ? audio.trimStartMs : 0;
      notify();
    },

    jumpToNodeOnTimeline(nodeId, occurrenceIndex = 0) {
      const idxEntry = timeline.nodeIndex[nodeId];
      if (!idxEntry) return false;
      const targetEntryIdx = idxEntry.timelineIndices[occurrenceIndex] ?? idxEntry.timelineIndex;
      if (targetEntryIdx === null || targetEntryIdx === undefined) return false;
      const targetEntry = timeline.entries[targetEntryIdx];
      if (!targetEntry) return false;

      clearGuessSession();
      mode = "timeline";
      globalTimeMs = targetEntry.startMs;
      notify();
      return true;
    },

    setManualClipTime(clipTimeMs) {
      if (!Number.isFinite(clipTimeMs)) {
        return;
      }
      manualClipTimeMs = Math.max(0, clipTimeMs);
      notify();
    },

    setSubtitleLang(lang) {
      subtitleLang = lang;
      notify();
    },

    setInteractiveGuessesEnabled(enabled) {
      interactiveGuessesEnabled = enabled;
      if (!enabled && guessPhase !== "idle") {
        clearGuessSession();
      }
      notify();
    },

    enterGuessPrompt(nodeId) {
      const spec = timeline.guesses?.[nodeId];
      if (!spec || spec.branches.length === 0) return false;
      isPlaying = false;
      guessPhase = "awaiting";
      activeGuess = spec;
      activeGuessPromptTimelineIndex = timeline.nodeIndex[nodeId]?.timelineIndex ?? null;
      activeBranch = null;
      lastGuessResult = null;
      branchTimeMs = 0;
      notify();
      return true;
    },

    submitGuessMove(from, to, promotion) {
      if (guessPhase !== "awaiting" || !activeGuess) {
        return { status: "unlisted", matchedBranchNodeId: null };
      }

      const promptFen = timeline.nodeIndex[activeGuess.promptNodeId]?.fen;
      if (!promptFen) {
        return { status: "unlisted", matchedBranchNodeId: null };
      }

      const applied = new ChessPosition(promptFen).tryMove({
        from,
        to,
        ...(promotion ? { promotion } : {}),
      });
      if (!applied) {
        return { status: "unlisted", matchedBranchNodeId: null };
      }

      const extractSanPromotion = (san: string): string | undefined => {
        const promoMatch = /=([QRBN])/i.exec(san);
        return promoMatch?.[1]?.toLowerCase();
      };

      const matched =
        activeGuess.branches.find((b) => b.san === applied.san) ??
        activeGuess.branches.find((b) => {
          const branchPromo = extractSanPromotion(b.san);
          return (
            b.from === applied.from &&
            b.to === applied.to &&
            (branchPromo ?? undefined) === (applied.promotion ?? undefined)
          );
        });

      if (!matched) {
        const unlisted: GuessEvaluationResult = {
          status: "unlisted",
          matchedBranchNodeId: null,
        };
        lastGuessResult = unlisted;
        notify();
        return unlisted;
      }

      const result: GuessEvaluationResult = {
        status: matched.outcome,
        matchedBranchNodeId: matched.nodeId,
      };
      lastGuessResult = result;

      // §8.3.2: Mainline success scheduled on main timeline resumes seamlessly
      if (
        matched.outcome === "success" &&
        matched.isMainline &&
        matched.mainTimelineIndex !== null &&
        mode === "timeline"
      ) {
        const resumeEntry = timeline.entries[matched.mainTimelineIndex];
        resolvedPromptIds.add(activeGuess.promptNodeId);
        guessPhase = "idle";
        activeGuess = null;
        activeGuessPromptTimelineIndex = null;
        activeBranch = null;
        branchTimeMs = 0;
        if (resumeEntry) {
          globalTimeMs = resumeEntry.startMs;
        }
        isPlaying = true;
        notify();
        return result;
      }

      // All other matched branches play branchTimeline from 0 to branchDurationMs
      activeBranch = matched;
      branchTimeMs = 0;
      if (matched.branchDurationMs <= 0) {
        if (activeGuess.returnPolicy === "auto" && matched.outcome !== "success") {
          guessPhase = "awaiting";
          activeBranch = null;
        } else {
          guessPhase = "branch_complete";
        }
        isPlaying = false;
      } else {
        guessPhase = "playing_branch";
        isPlaying = true;
      }

      notify();
      return result;
    },

    returnToGuess() {
      if (!activeGuess) return;
      guessPhase = "awaiting";
      activeBranch = null;
      branchTimeMs = 0;
      isPlaying = false;
      notify();
    },

    replayGuessBranch() {
      if (!activeGuess || !activeBranch) return;
      branchTimeMs = 0;
      guessPhase = "playing_branch";
      isPlaying = true;
      notify();
    },

    continueAfterGuess() {
      if (!activeGuess) return;
      const promptId = activeGuess.promptNodeId;
      const nextIndex =
        activeGuessPromptTimelineIndex !== null ? activeGuessPromptTimelineIndex + 1 : null;
      resolvedPromptIds.add(promptId);
      clearGuessSession();
      if (mode === "timeline" && nextIndex !== null) {
        const nextEntry = timeline.entries[nextIndex];
        globalTimeMs = nextEntry ? nextEntry.startMs : timeline.totalDurationMs;
        isPlaying = nextEntry !== undefined;
      }
      notify();
    },

    resetResolvedGuesses() {
      resolvedPromptIds.clear();
      notify();
    },
  };
}
