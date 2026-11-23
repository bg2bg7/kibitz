/**
 * Canonical PGNA v1.0 type contracts matching docs/PGNA-v1.0.md.
 * Pure isomorphic types — zero DOM / React / Node-only dependencies.
 */

export const PGNA_FORMAT_VERSION = "1.0" as const;
export const PGNA_MIME_TYPE = "application/vnd.pgn-audio+zip" as const;

export const DEFAULT_SILENT_DURATION_MS = 1500 as const;
export const DEFAULT_RETURN_PAUSE_MS = 1000 as const;
export const DEFAULT_GAP_MS = 0 as const;

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
  defaultReturnPauseMs: number;
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
  /** True when the timeline returns silently to an already-visited node (audio is always null). */
  isRevisit?: boolean;
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
  /** Parsed PGN prose commentary on this node (available even when unscheduled). */
  comment?: string;
  /** Parsed static `[%cal]` board arrows on this node (available even when unscheduled). */
  arrows?: ArrowAnnotation[];
  /** Parsed static `[%csl]` square highlights on this node (available even when unscheduled). */
  highlights?: SquareHighlight[];
  /** Primary (earliest) timeline entry index for this node, or null if unscheduled. */
  timelineIndex: number | null;
  /** All main-timeline entry indices for this node in ascending timeline order. */
  timelineIndices: number[];
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

export interface ParsedAtTag {
  mode: "ordinal" | "timestamp";
  /** For ordinal mode: the numeric ordinal (#1 -> 1). For timestamp mode: milliseconds. */
  value: number;
  /** Optional per-occurrence duration override from `dur=<time>`. */
  durMs?: number;
  rawSpec: string;
}

export type CueDirectiveKind =
  | "clear"
  | "cal"
  | "csl"
  | "+cal"
  | "-cal"
  | "+csl"
  | "-csl";

export interface ParsedCueDirective {
  kind: CueDirectiveKind;
  arrows?: ArrowAnnotation[];
  highlights?: SquareHighlight[];
}

export interface ParsedCueTag {
  offsetMs: number;
  directives: ParsedCueDirective[];
}

export interface ParsedNodeTags {
  prose: string;
  preservedTags: string[];
  arrows: ArrowAnnotation[];
  highlights: SquareHighlight[];
  audioClipId: string | null;
  atTags: ParsedAtTag[];
  durMs: number | null;
  orientation: BoardOrientation | null;
  guess: { returnPolicy: GuessReturnPolicy } | null;
  outcome: GuessOutcome | null;
  cues: ParsedCueTag[];
}
