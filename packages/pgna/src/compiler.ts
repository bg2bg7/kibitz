import {
  PGNA_FORMAT_VERSION,
  type PgnaDiagnostic,
  type PgnaManifest,
  type PgnaTimeline,
} from "./types.js";

export interface CompilePgnaInput {
  manifest: PgnaManifest;
  pgnText: string;
  /** Optional map of archive path -> raw WebVTT text for per-clip subtitle merging. */
  subtitlesByPath?: Record<string, string>;
}

export interface CompilePgnaResult {
  timeline: PgnaTimeline;
  mergedSubtitlesVtt: Record<string, string>;
  diagnostics: PgnaDiagnostic[];
}

/**
 * Compiler contract stub. Replace with the canonical PGNA v1.0 compiler implementation.
 */
export function compilePgna(_input: CompilePgnaInput): CompilePgnaResult {
  return {
    timeline: {
      format: "pgna-timeline",
      version: PGNA_FORMAT_VERSION,
      compiledAt: new Date().toISOString(),
      totalDurationMs: 0,
      games: [],
      entries: [],
      nodeIndex: {},
    },
    mergedSubtitlesVtt: {},
    diagnostics: [],
  };
}
