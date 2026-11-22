/**
 * Canonical PGNA v1.0 type contracts matching docs/PGNA-v1.0.md.
 * Ready for drop-in replacement by the owner's reference implementation.
 */

export const PGNA_FORMAT_VERSION = "1.0" as const;
export const PGNA_MIME_TYPE = "application/vnd.pgn-audio+zip" as const;

/** Canonical positional node address: `g<gameIndex>` or `g<gameIndex>/<c0>.<c1>...` */
export type NodeId = `g${number}` | `g${number}/${string}`;

export type BoardOrientation = "white" | "black";
export type AnnotationColor = "G" | "R" | "Y" | "B";
export type TimingMode = "flow" | "strict";
export type GuessReturnPolicy = "auto" | "manual";
export type GuessOutcome = "success" | "interesting" | "dubious" | "fail";

export interface ArrowAnnotation {
  color: AnnotationColor;
  from: string;
  to: string;
}

export interface SquareHighlight {
  color: AnnotationColor;
  square: string;
}

export interface LastMoveCoords {
  from: string;
  to: string;
}

export interface CompilationOptions {
  timingMode: TimingMode;
  defaultSilentDurationMs: number;
  defaultGapMs: number;
  includeUnscheduledAudio: boolean;
}

export interface ClipDefinition {
  id: string;
  path: string;
  mimeType: string;
  durationMs: number;
  trimStartMs?: number;
  trimEndMs?: number;
  label?: string;
  subtitles?: Record<string, string>;
}

export interface PgnaManifest {
  format: "pgna";
  version: typeof PGNA_FORMAT_VERSION;
  pgnPath: string;
  timelinePath: string;
  title?: string;
  author?: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
  defaultSubtitleLang?: string;
  compilation?: Partial<CompilationOptions>;
  clips: Record<string, ClipDefinition>;
}

export interface CueSnapshot {
  offsetMs: number;
  globalTimeMs: number;
  arrows: ArrowAnnotation[];
  highlights: SquareHighlight[];
}

export interface ResolvedClipAudio {
  clipId: string;
  path: string;
  mimeType: string;
  durationMs: number;
  trimStartMs: number;
  trimEndMs: number;
}

export interface GuessBranch {
  nodeId: NodeId;
  san: string;
  from: string;
  to: string;
  outcome: GuessOutcome;
  nags: string[];
  isMainline: boolean;
  mainTimelineIndex: number | null;
  branchTimeline: TimelineEntry[];
  branchDurationMs: number;
}

export interface GuessSpec {
  promptNodeId: NodeId;
  returnPolicy: GuessReturnPolicy;
  branches: GuessBranch[];
}

export interface TimelineEntry {
  index: number;
  startMs: number;
  endMs: number;
  gameIndex: number;
  nodeId: NodeId;
  ply: number;
  san: string | null;
  fen: string;
  lastMove: LastMoveCoords | null;
  orientation: BoardOrientation;
  comment: string;
  audio: ResolvedClipAudio | null;
  subtitles?: Record<string, string>;
  cues: CueSnapshot[];
  guess?: GuessSpec;
}

export interface TimelineGameMetadata {
  gameIndex: number;
  headers: Record<string, string>;
  initialFen: string;
  orientation: BoardOrientation;
}

export interface NodeIndexEntry {
  gameIndex: number;
  fen: string;
  lastMove: LastMoveCoords | null;
  orientation: BoardOrientation;
  clipId: string | null;
  subtitles?: Record<string, string>;
  timelineIndex: number | null;
}

export interface PgnaTimeline {
  format: "pgna-timeline";
  version: typeof PGNA_FORMAT_VERSION;
  compiledAt: string;
  totalDurationMs: number;
  games: TimelineGameMetadata[];
  mergedSubtitles?: Record<string, string>;
  entries: TimelineEntry[];
  nodeIndex: Record<string, NodeIndexEntry>;
  guesses?: Record<string, GuessSpec>;
}

export interface WebVttCue {
  startMs: number;
  endMs: number;
  text: string;
}

export type ZipCompressionMethod = 0 | 8; // 0 = STORE (required for audio), 8 = DEFLATE

export interface ArchiveEntry {
  path: string;
  compressionMethod: ZipCompressionMethod;
  data: Uint8Array;
}

export type PgnaDiagnosticSeverity = "error" | "warning";

export interface PgnaDiagnostic {
  code: string;
  severity: PgnaDiagnosticSeverity;
  message: string;
  nodeId?: NodeId;
  path?: string;
}
