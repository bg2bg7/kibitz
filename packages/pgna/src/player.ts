import { INITIAL_FEN } from "@suite/chess-core";
import type {
  ArrowAnnotation,
  BoardOrientation,
  GuessOutcome,
  LastMoveCoords,
  NodeId,
  PgnaTimeline,
  ResolvedClipAudio,
  SquareHighlight,
} from "./types.js";

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
  activeNodeId: NodeId | null;
  fen: string;
  lastMove: LastMoveCoords | null;
  orientation: BoardOrientation;
  arrows: ArrowAnnotation[];
  highlights: SquareHighlight[];
  activeAudio: ResolvedClipAudio | null;
  guessPhase: GuessSessionPhase;
}

export interface PgnaPlayerController {
  getSnapshot(): PlaybackSnapshot;
  setMode(mode: PlaybackMode): void;
  seek(globalTimeMs: number): void;
  selectNode(nodeId: NodeId): void;
  submitGuessMove(
    from: string,
    to: string,
    promotion?: "q" | "r" | "b" | "n",
  ): GuessEvaluationResult;
}

/**
 * Dual-mode playback state machine stub (Timeline Auto-Play, Manual Mode, interactive [%guess]).
 */
export function createPgnaPlayer(timeline: PgnaTimeline): PgnaPlayerController {
  let mode: PlaybackMode = "timeline";
  let globalTimeMs = 0;
  let activeNodeId: NodeId | null = timeline.entries[0]?.nodeId ?? null;

  const getSnapshot = (): PlaybackSnapshot => {
    const firstEntry = timeline.entries[0];
    return {
      mode,
      isPlaying: false,
      globalTimeMs,
      activeNodeId,
      fen: firstEntry?.fen ?? INITIAL_FEN,
      lastMove: firstEntry?.lastMove ?? null,
      orientation: firstEntry?.orientation ?? "white",
      arrows: firstEntry?.cues[0]?.arrows ?? [],
      highlights: firstEntry?.cues[0]?.highlights ?? [],
      activeAudio: null,
      guessPhase: "idle",
    };
  };

  return {
    getSnapshot,
    setMode(nextMode) {
      mode = nextMode;
    },
    seek(nextTimeMs) {
      globalTimeMs = Math.max(0, Math.min(nextTimeMs, timeline.totalDurationMs));
    },
    selectNode(nodeId) {
      mode = "manual";
      activeNodeId = nodeId;
    },
    submitGuessMove() {
      return { status: "unlisted", matchedBranchNodeId: null };
    },
  };
}
