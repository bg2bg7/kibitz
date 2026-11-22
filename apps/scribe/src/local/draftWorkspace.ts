import {
  DEFAULT_GAP_MS,
  DEFAULT_RETURN_PAUSE_MS,
  DEFAULT_SILENT_DURATION_MS,
  PGNA_FORMAT_VERSION,
  type PgnaManifest,
} from "@suite/pgna";

export interface ScribeDraft {
  id: string;
  manifest: PgnaManifest;
  pgnText: string;
  /** Map of archive audio path -> raw binary bytes. */
  audioByPath: Record<string, Uint8Array>;
  /** Map of archive subtitle path -> WebVTT text. */
  subtitlesByPath: Record<string, string>;
  updatedAt: string;
}

/**
 * Local-only PGNA draft manifest factory. Zero backend or auth dependencies.
 */
export function createLocalDraftManifest(title: string): PgnaManifest {
  const now = new Date().toISOString();
  return {
    format: "pgna",
    version: PGNA_FORMAT_VERSION,
    pgnPath: "study.pgn",
    timelinePath: "timeline.json",
    title,
    author: "",
    description: "",
    createdAt: now,
    updatedAt: now,
    defaultSubtitleLang: "en",
    compilation: {
      timingMode: "flow",
      defaultSilentDurationMs: DEFAULT_SILENT_DURATION_MS,
      defaultReturnPauseMs: DEFAULT_RETURN_PAUSE_MS,
      defaultGapMs: DEFAULT_GAP_MS,
      includeUnscheduledAudio: false,
    },
    clips: {},
  };
}

export function createDraftId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createBlankDraft(title = "Untitled PGNA Study"): ScribeDraft {
  const now = new Date().toISOString();
  return {
    id: createDraftId(),
    manifest: createLocalDraftManifest(title),
    pgnText: `[Event "${title}"]\n[Site "Scribe Studio"]\n[White "White"]\n[Black "Black"]\n[Result "*"]\n\n*`,
    audioByPath: {},
    subtitlesByPath: {},
    updatedAt: now,
  };
}

/**
 * Built-in local sample study showcasing variations, a silent return/revisit pause back to
 * the mainline, sub-move [%cue] annotations, and an interactive [%guess] prompt.
 */
export function createDemoItalianDraft(): ScribeDraft {
  const now = new Date().toISOString();
  const manifest = createLocalDraftManifest("Italian Game Essentials");
  manifest.author = "Coach Example";
  manifest.description =
    "Demonstrates PGNA v1.0 authoring: mainline, sideline variation, silent return pause to mainline, timed board cues, and an interactive guess prompt.";
  manifest.compilation = {
    timingMode: "flow",
    defaultSilentDurationMs: DEFAULT_SILENT_DURATION_MS,
    defaultReturnPauseMs: DEFAULT_RETURN_PAUSE_MS,
    defaultGapMs: 0,
    includeUnscheduledAudio: false,
  };

  const pgnText = [
    '[Event "Italian Game Essentials"]',
    '[Site "Scribe Studio"]',
    '[White "White"]',
    '[Black "Black"]',
    '[Orientation "white"]',
    '[Result "*"]',
    "",
    "{ Welcome to the Italian Game! Watch how White develops quickly toward f7. [%at #1 dur=2] [%csl Gf7] }",
    "1. e4 { Claim central space and open lines for the bishop and queen. [%cal Ge2e4,Gf1c4] [%at #2] }",
    "1... e5 { Black mirrors in the center. [%at #3] }",
    "2. Nf3 { Develop with tempo, attacking e5. [%cal Gg1f3,Rf3e5] [%at #4] [%at #6] [%cue 0.8 +csl=Re5] }",
    "2... Nc6 { Defend e5 naturally and prepare classical development. [%at #7] [%guess return=manual] }",
    "( 2... f6?! { Damiano's Defense weakens the king and walks into Nxe5! [%cal Rf7f6,Rf3e5] [%at #5 dur=2] } )",
    "3. Bc4! { The Italian Bishop targets f7 directly! [%cal Gf1c4,Rc4f7] [%at #8 dur=2] }",
    "( 3. Bb5 { The Ruy Lopez is also a strong classical choice! [%outcome interesting] [%cal Bf1b5] } 3... a6 4. Ba4 )",
    "( 3. d4 { The Scotch Game immediately opens the center. [%outcome interesting] [%cal Yd2d4] } )",
    "*",
  ].join("\n");

  return {
    id: "demo-italian-essentials",
    manifest,
    pgnText,
    audioByPath: {},
    subtitlesByPath: {},
    updatedAt: now,
  };
}
