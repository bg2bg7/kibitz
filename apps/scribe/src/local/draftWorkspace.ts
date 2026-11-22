import { PGNA_FORMAT_VERSION, type PgnaManifest } from "@suite/pgna";

/**
 * Local-only PGNA draft workspace factory. Zero backend or auth dependencies.
 */
export function createLocalDraftManifest(title: string): PgnaManifest {
  const now = new Date().toISOString();
  return {
    format: "pgna",
    version: PGNA_FORMAT_VERSION,
    pgnPath: "study.pgn",
    timelinePath: "timeline.json",
    title,
    createdAt: now,
    updatedAt: now,
    compilation: {
      timingMode: "flow",
      defaultSilentDurationMs: 1500,
      defaultGapMs: 0,
      includeUnscheduledAudio: false,
    },
    clips: {},
  };
}
