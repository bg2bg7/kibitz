import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETURN_PAUSE_MS,
  DEFAULT_SILENT_DURATION_MS,
  PGNA_FORMAT_VERSION,
  ZIP_METHOD_DEFLATE,
  ZIP_METHOD_STORE,
  compilePgna,
  createPgnaPlayer,
  formatNodeComment,
  isSafeArchivePath,
  isValidClipId,
  isValidNodeId,
  packPgnaArchive,
  packPgnaZip,
  parseNodeComments,
  parseWebVtt,
  prepareArchiveEntries,
  unpackPgnaArchive,
  unpackPgnaZip,
  utf8Encode,
  validatePgnaArchive,
  validatePgnaPackage,
  validatePgnaZip,
  type PgnaManifest,
} from "./index.js";

function makeBaseManifest(overrides: Partial<PgnaManifest> = {}): PgnaManifest {
  return {
    format: "pgna",
    version: PGNA_FORMAT_VERSION,
    pgnPath: "study.pgn",
    timelinePath: "timeline.json",
    title: "Test Study",
    compilation: {
      timingMode: "flow",
      defaultSilentDurationMs: DEFAULT_SILENT_DURATION_MS,
      defaultReturnPauseMs: DEFAULT_RETURN_PAUSE_MS,
      defaultGapMs: 0,
      includeUnscheduledAudio: false,
    },
    clips: {},
    ...overrides,
  };
}

describe("@suite/pgna v1.0 full library", () => {
  it("enforces PGNA v1.0 §2.1 archive-relative POSIX path safety", () => {
    expect(isSafeArchivePath("manifest.json")).toBe(true);
    expect(isSafeArchivePath("audio/clip-001.ogg")).toBe(true);
    expect(isSafeArchivePath("subtitles/en/timeline.vtt")).toBe(true);

    expect(isSafeArchivePath("")).toBe(false);
    expect(isSafeArchivePath("/etc/passwd")).toBe(false);
    expect(isSafeArchivePath("../escape.ogg")).toBe(false);
    expect(isSafeArchivePath("audio/./clip.ogg")).toBe(false);
    expect(isSafeArchivePath("audio//clip.ogg")).toBe(false);
    expect(isSafeArchivePath("audio\\clip.ogg")).toBe(false);
    expect(isSafeArchivePath("C:clip.ogg")).toBe(false);
  });

  it("validates canonical NodeId and ClipId formats", () => {
    expect(isValidNodeId("g0")).toBe(true);
    expect(isValidNodeId("g0/0.1.0")).toBe(true);
    expect(isValidNodeId("0/0")).toBe(false);

    expect(isValidClipId("clip-001")).toBe(true);
    expect(isValidClipId("timeline")).toBe(false);
    expect(isValidClipId("clip 001")).toBe(false);
  });

  it("enforces ZIP STORE (method 0) on audio clips", () => {
    const audioPaths = new Set(["audio/clip-001.ogg"]);
    const entries = prepareArchiveEntries(
      [
        { path: "manifest.json", data: new Uint8Array([1]) },
        { path: "audio/clip-001.ogg", data: new Uint8Array([2]) },
      ],
      { storePaths: audioPaths },
    );

    expect(entries[0]?.compressionMethod).toBe(ZIP_METHOD_DEFLATE);
    expect(entries[1]?.compressionMethod).toBe(ZIP_METHOD_STORE);
    expect(validatePgnaArchive(entries, audioPaths).valid).toBe(true);

    const invalidResult = validatePgnaArchive(
      [
        {
          path: "audio/clip-001.ogg",
          data: new Uint8Array([2]),
          compressionMethod: ZIP_METHOD_DEFLATE,
        },
      ],
      audioPaths,
    );
    expect(invalidResult.valid).toBe(false);
    expect(invalidResult.diagnostics[0]?.code).toBe("AUDIO_NOT_STORED");
  });

  it("parses and round-trips PGNA comment tags including multiple [%at] and preserved tags", () => {
    const { tags, diagnostics } = parseNodeComments([
      "Control the center. [%clk 0:05:00] [%cal Ge2e4] [%csl Ye4] [%audio clip-001] [%at #1] [%at #4 dur=1.25] [%cue 1.5 +cal=Rd2d4 csl=Ge4]",
    ]);

    expect(diagnostics).toHaveLength(0);
    expect(tags.prose).toBe("Control the center.");
    expect(tags.preservedTags).toEqual(["[%clk 0:05:00]"]);
    expect(tags.audioClipId).toBe("clip-001");
    expect(tags.atTags).toEqual([
      { mode: "ordinal", value: 1, rawSpec: "#1" },
      { mode: "ordinal", value: 4, durMs: 1250, rawSpec: "#4" },
    ]);
    expect(tags.cues).toHaveLength(1);

    const formatted = formatNodeComment(tags);
    const reparsed = parseNodeComments([formatted]);
    expect(reparsed.tags).toEqual(tags);
  });

  it("rejects duplicate [%audio] tags on the same node while allowing silent [%at] revisits", () => {
    const manifest = makeBaseManifest({
      compilation: {
        timingMode: "flow",
        defaultSilentDurationMs: 1800,
        defaultReturnPauseMs: 900,
        defaultGapMs: 0,
        includeUnscheduledAudio: false,
      },
      clips: {
        "clip-e4": {
          id: "clip-e4",
          path: "audio/clip-e4.ogg",
          mimeType: "audio/ogg; codecs=opus",
          durationMs: 3000,
        },
        "clip-var": {
          id: "clip-var",
          path: "audio/clip-var.ogg",
          mimeType: "audio/ogg; codecs=opus",
          durationMs: 2000,
        },
      },
    });

    // 1. e4 plays audio at #1, then variation 1... c5 plays at #2,
    //    then returns silently to 1. e4 at #3 (defaultReturnPauseMs = 900ms),
    //    then silent move 1... e5 plays at #4 (defaultSilentDurationMs = 1800ms),
    //    then returns silently to 1. e4 at #5 with custom dur=0.5 (500ms).
    const pgn = `
      1. e4 { Mainline opening [%cal Ge2e4] [%audio clip-e4] [%at #1] [%at #3] [%at #5 dur=0.5] [%cue 1.0 +csl=Ge4] }
      1... e5 { Silent mainline reply [%at #4] }
      (1... c5 { Sicilian sideline [%audio clip-var] [%at #2] })
      *
    `;

    const result = compilePgna({ manifest, pgnText: pgn });
    expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const { entries, nodeIndex } = result.timeline;
    expect(entries).toHaveLength(5);

    // #1: primary visit to g0/0 (1. e4) plays audio + cues
    expect(entries[0]).toMatchObject({
      nodeId: "g0/0",
      startMs: 0,
      endMs: 3000,
    });
    expect(entries[0]?.isRevisit).toBeUndefined();
    expect(entries[0]?.audio?.clipId).toBe("clip-e4");
    expect(entries[0]?.cues).toHaveLength(2);

    // #2: variation g0/0.1 (1... c5)
    expect(entries[1]).toMatchObject({
      nodeId: "g0/0.1",
      startMs: 3000,
      endMs: 5000,
    });
    expect(entries[1]?.audio?.clipId).toBe("clip-var");

    // #3: silent revisit to g0/0 (defaultReturnPauseMs = 900ms, audio = null, baseline cue only)
    expect(entries[2]).toMatchObject({
      nodeId: "g0/0",
      startMs: 5000,
      endMs: 5900,
      audio: null,
      isRevisit: true,
    });
    expect(entries[2]?.cues).toHaveLength(1);
    expect(entries[2]?.cues[0]?.arrows).toEqual([{ color: "G", from: "e2", to: "e4" }]);

    // #4: no-audio move g0/0.0 (1... e5) uses defaultSilentDurationMs = 1800ms
    expect(entries[3]).toMatchObject({
      nodeId: "g0/0.0",
      startMs: 5900,
      endMs: 7700,
      audio: null,
    });

    // #5: second silent revisit to g0/0 with explicit dur=0.5 (500ms)
    expect(entries[4]).toMatchObject({
      nodeId: "g0/0",
      startMs: 7700,
      endMs: 8200,
      audio: null,
      isRevisit: true,
    });

    // nodeIndex tracks primary timelineIndex and all timelineIndices
    expect(nodeIndex["g0/0"]?.timelineIndex).toBe(0);
    expect(nodeIndex["g0/0"]?.timelineIndices).toEqual([0, 2, 4]);

    // Duplicate [%audio] must still error
    const dupAudio = compilePgna({
      manifest,
      pgnText: "1. e4 { [%audio clip-e4] [%audio clip-var] [%at #1] } *",
    });
    expect(dupAudio.diagnostics.some((d) => d.code === "DUPLICATE_AUDIO_TAG")).toBe(true);
  });

  it("enforces MIXED_TIMELINE_MODES, strict TIMELINE_OVERLAP, and flow TIMELINE_REFLOWED", () => {
    const mixed = compilePgna({
      manifest: makeBaseManifest(),
      pgnText: "1. e4 { [%at #1] } 1... e5 { [%at 5.0] } *",
    });
    expect(mixed.diagnostics.some((d) => d.code === "MIXED_TIMELINE_MODES")).toBe(true);

    const strictOverlap = compilePgna({
      manifest: makeBaseManifest({
        compilation: { timingMode: "strict", defaultSilentDurationMs: 2000 },
      }),
      pgnText: "1. e4 { [%at 0] } 1... e5 { [%at 1.0] } *",
    });
    expect(strictOverlap.diagnostics.some((d) => d.code === "TIMELINE_OVERLAP")).toBe(true);

    const flowReflow = compilePgna({
      manifest: makeBaseManifest({
        compilation: { timingMode: "flow", defaultSilentDurationMs: 2000, defaultGapMs: 250 },
      }),
      pgnText: "1. e4 { [%at 0] } 1... e5 { [%at 1.0] } *",
    });
    expect(flowReflow.diagnostics.some((d) => d.code === "TIMELINE_REFLOWED")).toBe(true);
    expect(flowReflow.timeline.entries[1]?.startMs).toBe(2250);
  });

  it("folds pre-trim [%cue] directives, warns on CUE_OUT_OF_BOUNDS, and merges trimmed WebVTT subtitles", () => {
    const manifest = makeBaseManifest({
      defaultSubtitleLang: "en",
      clips: {
        "clip-1": {
          id: "clip-1",
          path: "audio/clip-1.ogg",
          mimeType: "audio/ogg; codecs=opus",
          durationMs: 6000,
          trimStartMs: 1000,
          trimEndMs: 4000,
          subtitles: { en: "subtitles/en/clip-1.vtt" },
        },
      },
    });

    const vtt = [
      "WEBVTT",
      "",
      "00:00.000 --> 00:00.800",
      "Dropped before trim",
      "",
      "00:00.500 --> 00:02.000",
      "Clamped opening",
      "",
      "00:03.500 --> 00:05.000",
      "Clamped closing",
      "",
      "00:04.500 --> 00:05.500",
      "Dropped after trim",
    ].join("\n");

    const pgn = `
      1. e4 {
        Intro [%cal Ge2e4] [%audio clip-1] [%at #1] [%at #2]
        [%cue 0.500 +csl=Ge4]
        [%cue 2.500 +cal=Rd2d4 -cal=Ge2e4]
        [%cue 4.200 clear]
      } *
    `;

    const compiled = compilePgna({
      manifest,
      pgnText: pgn,
      subtitlesByPath: { "subtitles/en/clip-1.vtt": vtt },
    });

    expect(compiled.diagnostics.some((d) => d.code === "CUE_OUT_OF_BOUNDS")).toBe(true);

    const entry = compiled.timeline.entries[0]!;
    expect(entry.endMs - entry.startMs).toBe(3000);
    // Cue at 0.500s folded into baseline offsetMs 0
    expect(entry.cues[0]).toMatchObject({
      offsetMs: 0,
      arrows: [{ color: "G", from: "e2", to: "e4" }],
      highlights: [{ color: "G", square: "e4" }],
    });
    // Cue at 2.500s shifted by trimStartMs (1000ms) -> 1500ms; canonical order adds Rd2d4 and removes Ge2e4
    expect(entry.cues[1]).toMatchObject({
      offsetMs: 1500,
      arrows: [{ color: "R", from: "d2", to: "d4" }],
      highlights: [{ color: "G", square: "e4" }],
    });
    expect(entry.cues).toHaveLength(2);

    // Merged subtitles: dropped outside [1000, 4000], clamped and shifted; revisit #2 emits nothing
    const mergedVtt = compiled.mergedSubtitlesVtt["subtitles/en/timeline.vtt"];
    expect(mergedVtt).toBeDefined();
    const parsedMerged = parseWebVtt(mergedVtt!);
    expect(parsedMerged).toEqual([
      { startMs: 0, endMs: 1000, text: "Clamped opening" },
      { startMs: 2500, endMs: 3000, text: "Clamped closing" },
    ]);
  });

  it("compiles [%guess] prompts, NAG/outcome classification, and executes interactive playback", () => {
    const manifest = makeBaseManifest({
      compilation: {
        timingMode: "flow",
        defaultSilentDurationMs: 1000,
        defaultReturnPauseMs: 800,
        defaultGapMs: 0,
        includeUnscheduledAudio: false,
      },
    });

    const pgn = `
      1. e4 { Opening [%at #1] [%guess return=manual] }
      1... e5! { Best response [%at #2] }
      (1... c5?! { Sharp sideline } 2. Nf3)
      (1... d5 { [%outcome interesting] Scandinavian })
      *
    `;

    const compiled = compilePgna({ manifest, pgnText: pgn });
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const guess = compiled.timeline.guesses?.["g0/0"];
    expect(guess).toBeDefined();
    expect(guess?.branches.map((b) => [b.san, b.outcome, b.isMainline])).toEqual([
      ["e5", "success", true],
      ["c5", "dubious", false],
      ["d5", "interesting", false],
    ]);

    const player = createPgnaPlayer(compiled.timeline);
    player.play();
    // Single large tick spanning past entry 0's endMs (1000ms) MUST clamp to 1000ms and pause awaiting guess
    const pausedSnap = player.tick(5000);
    expect(pausedSnap.globalTimeMs).toBe(1000);
    expect(pausedSnap.isPlaying).toBe(false);
    expect(pausedSnap.guessPhase).toBe("awaiting");

    // Unlisted legal move stays awaiting
    const unlisted = player.submitGuessMove("e7", "e6");
    expect(unlisted).toEqual({ status: "unlisted", matchedBranchNodeId: null });
    expect(player.getSnapshot().guessPhase).toBe("awaiting");

    // Variation move plays branchTimeline
    const varRes = player.submitGuessMove("c7", "c5");
    expect(varRes).toEqual({ status: "dubious", matchedBranchNodeId: "g0/0.1" });
    expect(player.getSnapshot().guessPhase).toBe("playing_branch");

    // Tick through 2 moves in variation branch (2000ms total)
    const afterBranch = player.tick(2500);
    expect(afterBranch.guessPhase).toBe("branch_complete");
    expect(afterBranch.isPlaying).toBe(false);

    // Return to guess and submit mainline success -> seamlessly resumes main timeline
    player.returnToGuess();
    expect(player.getSnapshot().guessPhase).toBe("awaiting");

    const okRes = player.submitGuessMove("e7", "e5");
    expect(okRes).toEqual({ status: "success", matchedBranchNodeId: "g0/0.0" });
    const resumed = player.getSnapshot();
    expect(resumed.guessPhase).toBe("idle");
    expect(resumed.isPlaying).toBe(true);
    expect(resumed.activeNodeId).toBe("g0/0.0");
  });

  it("packs, unpacks, and validates .pgna ZIP archives with STORE audio, DEFLATE metadata, and STALE_TIMELINE detection", async () => {
    const manifest = makeBaseManifest({
      clips: {
        "clip-1": {
          id: "clip-1",
          path: "audio/clip-1.ogg",
          mimeType: "audio/ogg; codecs=opus",
          durationMs: 2500,
        },
      },
    });
    const fakeAudio = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x01, 0x02, 0x03]);
    const pgnText = "1. e4 { Intro [%audio clip-1] [%at #1] [%at #3] } 1... e5 { Reply [%at #2] } *";

    const packed = await packPgnaArchive({
      manifest,
      pgnText,
      audioByPath: { "audio/clip-1.ogg": fakeAudio },
      compiledAt: "2026-11-22T00:00:00.000Z",
    });

    const validation = await validatePgnaZip(packed.zipBytes);
    expect(validation.valid).toBe(true);

    const unpacked = await unpackPgnaArchive(packed.zipBytes);
    expect(unpacked.manifest.title).toBe("Test Study");
    expect(unpacked.pgnText).toBe(pgnText);
    expect(unpacked.audioByPath["audio/clip-1.ogg"]).toEqual(fakeAudio);
    expect(unpacked.timeline.entries).toHaveLength(3);
    expect(unpacked.timeline.entries[2]?.isRevisit).toBe(true);
    expect(unpacked.timeline.entries[2]?.audio).toBeNull();

    // Verify ZIP compression methods directly from unpacked raw entries
    const rawEntries = await unpackPgnaZip(packed.zipBytes);
    const byPath = new Map(rawEntries.map((e) => [e.path, e]));
    expect(byPath.get("audio/clip-1.ogg")?.compressionMethod).toBe(ZIP_METHOD_STORE);
    expect(byPath.get("manifest.json")?.compressionMethod).toBe(ZIP_METHOD_DEFLATE);
    expect(byPath.get("study.pgn")?.compressionMethod).toBe(ZIP_METHOD_DEFLATE);

    // Tamper with timeline.json -> validator MUST emit STALE_TIMELINE
    const tamperedTimeline = { ...unpacked.timeline, totalDurationMs: 999999 };
    const tamperedEntries = rawEntries.map((e) =>
      e.path === "timeline.json"
        ? { ...e, data: utf8Encode(JSON.stringify(tamperedTimeline)) }
        : e,
    );
    const staleResult = validatePgnaPackage(tamperedEntries);
    expect(staleResult.valid).toBe(false);
    expect(staleResult.diagnostics.some((d) => d.code === "STALE_TIMELINE")).toBe(true);

    // Pack audio with DEFLATE instead of STORE -> validator MUST emit AUDIO_NOT_STORED
    const badAudioZip = await packPgnaZip(
      rawEntries.map((e) =>
        e.path === "audio/clip-1.ogg" ? { ...e, compressionMethod: ZIP_METHOD_DEFLATE } : e,
      ),
    );
    const badAudioResult = await validatePgnaZip(badAudioZip);
    expect(badAudioResult.valid).toBe(false);
    expect(badAudioResult.diagnostics.some((d) => d.code === "AUDIO_NOT_STORED")).toBe(true);
  });

  it("keeps player audio strictly silent on revisit pauses and gaps while playing primary audio", () => {
    const manifest = makeBaseManifest({
      compilation: {
        timingMode: "flow",
        defaultSilentDurationMs: 1200,
        defaultReturnPauseMs: 800,
        defaultGapMs: 200,
      },
      clips: {
        c1: {
          id: "c1",
          path: "audio/c1.ogg",
          mimeType: "audio/ogg; codecs=opus",
          durationMs: 2000,
        },
      },
    });
    const compiled = compilePgna({
      manifest,
      pgnText: "1. e4 { [%audio c1] [%at #1] [%at #3] } 1... e5 { [%at #2] } *",
    });
    const player = createPgnaPlayer(compiled.timeline);

    // Entry 0: 0..2000ms (audio c1)
    player.seek(500);
    let snap = player.getSnapshot();
    expect(snap.activeNodeId).toBe("g0/0");
    expect(snap.isRevisit).toBe(false);
    expect(snap.activeAudio?.clipId).toBe("c1");
    expect(snap.audioTimeMs).toBe(500);

    // Gap: 2000..2200ms (silent)
    player.seek(2100);
    snap = player.getSnapshot();
    expect(snap.activeAudio).toBeNull();

    // Entry 1: 2200..3400ms (silent move 1... e5)
    player.seek(2500);
    snap = player.getSnapshot();
    expect(snap.activeNodeId).toBe("g0/0.0");
    expect(snap.activeAudio).toBeNull();

    // Entry 2: 3600..4400ms (silent revisit to 1. e4)
    player.seek(3800);
    snap = player.getSnapshot();
    expect(snap.activeNodeId).toBe("g0/0");
    expect(snap.isRevisit).toBe(true);
    expect(snap.activeAudio).toBeNull();
    expect(snap.audioTimeMs).toBeNull();

    // Jump to second timeline occurrence (revisit) from Manual Mode
    player.selectNode("g0/0");
    expect(player.getSnapshot().mode).toBe("manual");
    expect(player.jumpToNodeOnTimeline("g0/0", 1)).toBe(true);
    expect(player.getSnapshot().mode).toBe("timeline");
    expect(player.getSnapshot().globalTimeMs).toBe(3600);
    expect(player.getSnapshot().isRevisit).toBe(true);
  });
});
