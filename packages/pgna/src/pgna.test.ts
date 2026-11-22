import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETURN_PAUSE_MS,
  DEFAULT_SILENT_DURATION_MS,
  PGNA_FORMAT_VERSION,
  ZIP_METHOD_DEFLATE,
  ZIP_METHOD_STORE,
  compilePgna,
  computeCrc32,
  createPgnaPlayer,
  formatNodeComment,
  isSafeArchivePath,
  isValidClipId,
  isValidNodeId,
  isValidSubtitleLang,
  mergeTimelineSubtitles,
  packPgnaArchive,
  packPgnaZip,
  parseNodeComments,
  parsePgnaTimeMs,
  parseWebVtt,
  prepareArchiveEntries,
  unpackPgnaArchive,
  unpackPgnaZip,
  utf8Encode,
  validatePgnaArchive,
  validatePgnaPackage,
  validatePgnaZip,
  type ArchiveEntry,
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

interface CraftedZipEntry {
  cdPath: string;
  lfhPath?: string;
  method?: number;
  lfhMethod?: number;
  flags?: number;
  lfhFlags?: number;
  payload: Uint8Array;
  uncompressedSize?: number;
  crc32?: number;
}

function buildCraftedZip(
  items: readonly CraftedZipEntry[],
  eocdOverrides: { diskNumber?: number; cdStartDisk?: number; diskEntries?: number; cdSizeDelta?: number } = {},
): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const item of items) {
    const cdName = utf8Encode(item.cdPath);
    const lfhName = utf8Encode(item.lfhPath ?? item.cdPath);
    const method = item.method ?? ZIP_METHOD_STORE;
    const lfhMethod = item.lfhMethod ?? method;
    const flags = item.flags ?? 0x0800;
    const lfhFlags = item.lfhFlags ?? flags;
    const uncompressedSize = item.uncompressedSize ?? item.payload.byteLength;
    const crc = item.crc32 ?? computeCrc32(item.payload);

    const lfh = new Uint8Array(30 + lfhName.length);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, lfhFlags, true);
    lv.setUint16(8, lfhMethod, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, item.payload.byteLength, true);
    lv.setUint32(22, uncompressedSize, true);
    lv.setUint16(26, lfhName.length, true);
    lv.setUint16(28, 0, true);
    lfh.set(lfhName, 30);

    const cd = new Uint8Array(46 + cdName.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, item.payload.byteLength, true);
    cv.setUint32(24, uncompressedSize, true);
    cv.setUint16(28, cdName.length, true);
    cv.setUint32(42, localOffset, true);
    cd.set(cdName, 46);

    localParts.push(lfh, item.payload);
    centralParts.push(cd);
    localOffset += lfh.byteLength + item.payload.byteLength;
  }

  let centralSize = 0;
  for (const p of centralParts) centralSize += p.byteLength;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, eocdOverrides.diskNumber ?? 0, true);
  ev.setUint16(6, eocdOverrides.cdStartDisk ?? 0, true);
  ev.setUint16(8, eocdOverrides.diskEntries ?? items.length, true);
  ev.setUint16(10, items.length, true);
  ev.setUint32(12, Math.max(0, centralSize + (eocdOverrides.cdSizeDelta ?? 0)), true);
  ev.setUint32(16, localOffset, true);
  ev.setUint16(20, 0, true);

  const out = new Uint8Array(localOffset + centralSize + 22);
  let pos = 0;
  for (const p of localParts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  for (const p of centralParts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  out.set(eocd, pos);
  return out;
}

describe("@suite/pgna Phase 2 security & ZIP hardening", () => {
  it("validates subtitle language tags and rejects traversal and prototype-pollution keys", () => {
    expect(isValidSubtitleLang("en")).toBe(true);
    expect(isValidSubtitleLang("en-US")).toBe(true);
    expect(isValidSubtitleLang("zh-Hans-CN")).toBe(true);
    expect(isValidSubtitleLang("es-419")).toBe(true);

    expect(isValidSubtitleLang("../evil")).toBe(false);
    expect(isValidSubtitleLang("en/../../escape")).toBe(false);
    expect(isValidSubtitleLang("__proto__")).toBe(false);
    expect(isValidSubtitleLang("constructor")).toBe(false);
    expect(isValidSubtitleLang("prototype")).toBe(false);
    expect(isValidSubtitleLang("")).toBe(false);
    expect(isValidSubtitleLang("e")).toBe(false);
    expect(isValidSubtitleLang("en_US")).toBe(false);

    // Compiler rejects invalid subtitle lang and omits it from resolved subtitles & mergedSubtitles
    const badSubtitles = Object.assign(Object.create(null) as Record<string, string>, {
      en: "subtitles/en/c1.vtt",
      "../evil": "subtitles/evil/c1.vtt",
      ["__proto__"]: "subtitles/proto/c1.vtt",
      constructor: "subtitles/ctor/c1.vtt",
    });

    const manifest = makeBaseManifest({
      clips: {
        c1: {
          id: "c1",
          path: "audio/c1.ogg",
          mimeType: "audio/ogg; codecs=opus",
          durationMs: 2000,
          subtitles: badSubtitles,
        },
      },
    });

    const compiled = compilePgna({
      manifest,
      pgnText: "1. e4 { [%audio c1] [%at #1] } *",
      subtitlesByPath: {
        "subtitles/en/c1.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nHello",
        "subtitles/evil/c1.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nBad",
        "subtitles/proto/c1.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nProto",
      },
    });

    expect(compiled.diagnostics.filter((d) => d.code === "INVALID_SUBTITLE_LANG")).toHaveLength(3);
    expect(Object.keys(compiled.mergedSubtitlesVtt)).toEqual(["subtitles/en/timeline.vtt"]);
    expect(compiled.timeline.mergedSubtitles).toEqual({ en: "subtitles/en/timeline.vtt" });

    // mergeTimelineSubtitles directly skips invalid lang keys
    const directMerged = mergeTimelineSubtitles(
      [
        {
          ...compiled.timeline.entries[0]!,
          subtitles: {
            "../bad": "subtitles/evil/c1.vtt",
            constructor: "subtitles/ctor/c1.vtt",
          },
        },
      ],
      {
        "subtitles/evil/c1.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nBad",
        "subtitles/ctor/c1.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nCtor",
      },
    );
    expect(Object.keys(directMerged.mergedSubtitlesVtt)).toHaveLength(0);
  });

  it("handles malformed manifest.json and timeline.json without throwing TypeError and validates manifest even when PGN/timeline are missing", () => {
    // Non-object manifest.json (array / null)
    for (const badJson of ["null", "[]", '"hello"', "42"]) {
      const res = validatePgnaPackage([
        { path: "manifest.json", compressionMethod: ZIP_METHOD_DEFLATE, data: utf8Encode(badJson) },
      ]);
      expect(res.valid).toBe(false);
      expect(res.diagnostics.some((d) => d.code === "INVALID_MANIFEST_JSON")).toBe(true);
    }

    // Malformed clips, non-string pgnPath, unsafe timelinePath, non-object timeline.json
    const badManifest = {
      format: "not-pgna",
      version: "9.9",
      pgnPath: 123,
      timelinePath: "../escape.json",
      clips: ["not-an-object"],
    };
    const resMalformed = validatePgnaPackage([
      {
        path: "manifest.json",
        compressionMethod: ZIP_METHOD_DEFLATE,
        data: utf8Encode(JSON.stringify(badManifest)),
      },
    ]);
    expect(resMalformed.valid).toBe(false);
    expect(resMalformed.diagnostics.some((d) => d.code === "INVALID_MANIFEST")).toBe(true);
    expect(resMalformed.diagnostics.some((d) => d.code === "UNSAFE_ARCHIVE_PATH")).toBe(true);

    // Non-object clip entry + non-object timeline.json
    const resBadClipAndTimeline = validatePgnaPackage([
      {
        path: "manifest.json",
        compressionMethod: ZIP_METHOD_DEFLATE,
        data: utf8Encode(
          JSON.stringify({
            format: "pgna",
            version: "1.0",
            clips: { c1: null },
          }),
        ),
      },
      { path: "study.pgn", compressionMethod: ZIP_METHOD_DEFLATE, data: utf8Encode("1. e4 *") },
      { path: "timeline.json", compressionMethod: ZIP_METHOD_DEFLATE, data: utf8Encode("[]") },
    ]);
    expect(resBadClipAndTimeline.valid).toBe(false);
    expect(resBadClipAndTimeline.diagnostics.some((d) => d.code === "INVALID_MANIFEST")).toBe(true);
    expect(resBadClipAndTimeline.diagnostics.some((d) => d.code === "INVALID_TIMELINE_JSON")).toBe(true);

    // Missing PGN & timeline MUST NOT short-circuit before reporting manifest/clip errors
    const resMissingAndBadManifest = validatePgnaPackage([
      {
        path: "manifest.json",
        compressionMethod: ZIP_METHOD_DEFLATE,
        data: utf8Encode(
          JSON.stringify({
            format: "wrong-format",
            version: "1.0",
            pgnPath: "study.pgn",
            timelinePath: "timeline.json",
            clips: {
              c1: { id: "c1", path: "audio/c1.ogg", mimeType: "audio/ogg", durationMs: -10 },
            },
          }),
        ),
      },
    ]);
    expect(resMissingAndBadManifest.valid).toBe(false);
    const codes = new Set(resMissingAndBadManifest.diagnostics.map((d) => d.code));
    expect(codes.has("MISSING_ARCHIVE_ENTRY")).toBe(true);
    expect(codes.has("INVALID_MANIFEST")).toBe(true);
    expect(codes.has("INVALID_CLIP_DURATION")).toBe(true);
  });

  it("rejects duplicate archive entries in prepareArchiveEntries, packPgnaZip, unpackPgnaZip, and validatePgnaPackage", async () => {
    expect(() =>
      prepareArchiveEntries([
        { path: "study.pgn", data: utf8Encode("1. e4 *") },
        { path: "study.pgn", data: utf8Encode("1. d4 *") },
      ]),
    ).toThrow(/Duplicate/);

    await expect(
      packPgnaZip([
        { path: "study.pgn", compressionMethod: ZIP_METHOD_DEFLATE, data: utf8Encode("1. e4 *") },
        { path: "study.pgn", compressionMethod: ZIP_METHOD_DEFLATE, data: utf8Encode("1. d4 *") },
      ]),
    ).rejects.toThrow(/Duplicate/);

    const dupZip = buildCraftedZip([
      { cdPath: "study.pgn", payload: utf8Encode("1. e4 *") },
      { cdPath: "study.pgn", payload: utf8Encode("1. d4 *") },
    ]);
    await expect(unpackPgnaZip(dupZip)).rejects.toThrow(/Duplicate ZIP archive entry/);

    const validPacked = await packPgnaArchive({
      manifest: makeBaseManifest(),
      pgnText: "1. e4 { [%at #1] } *",
    });
    const dupEntries: ArchiveEntry[] = [
      ...validPacked.entries,
      validPacked.entries.find((e) => e.path === "study.pgn")!,
    ];
    const pkgResult = validatePgnaPackage(dupEntries);
    expect(pkgResult.valid).toBe(false);
    expect(pkgResult.diagnostics.some((d) => d.code === "DUPLICATE_ARCHIVE_ENTRY")).toBe(true);
  });

  it("enforces UnpackZipLimits including streaming Zip Bomb cutoff, multi-disk, encryption, unsafe directory paths, and LFH consistency", async () => {
    // 1. maxEntries limit
    const multiEntryZip = await packPgnaZip([
      { path: "a.txt", compressionMethod: ZIP_METHOD_STORE, data: utf8Encode("a") },
      { path: "b.txt", compressionMethod: ZIP_METHOD_STORE, data: utf8Encode("b") },
      { path: "c.txt", compressionMethod: ZIP_METHOD_STORE, data: utf8Encode("c") },
    ]);
    await expect(unpackPgnaZip(multiEntryZip, { maxEntries: 2 })).rejects.toThrow(/entry count/);
    const valLimit = await validatePgnaZip(multiEntryZip, { maxEntries: 2 });
    expect(valLimit.valid).toBe(false);
    expect(valLimit.diagnostics[0]?.code).toBe("INVALID_ZIP_ARCHIVE");

    // 2. maxEntryBytes pre-decompression check and maxTotalUncompressedBytes check
    const bigStoreZip = await packPgnaZip([
      { path: "a.bin", compressionMethod: ZIP_METHOD_STORE, data: new Uint8Array(100) },
      { path: "b.bin", compressionMethod: ZIP_METHOD_STORE, data: new Uint8Array(100) },
    ]);
    await expect(unpackPgnaZip(bigStoreZip, { maxEntryBytes: 50 })).rejects.toThrow(/exceeds maximum/);
    await expect(unpackPgnaZip(bigStoreZip, { maxTotalUncompressedBytes: 150 })).rejects.toThrow(/total uncompressed/);

    // 3. Streaming Zip Bomb defense: forged small uncompressedSize header on large deflated payload
    const largeZeros = new Uint8Array(256 * 1024);
    const honestZip = await packPgnaZip([
      { path: "bomb.bin", compressionMethod: ZIP_METHOD_DEFLATE, data: largeZeros },
    ]);
    // Extract compressed payload from honestZip LFH (offset 30 + nameLen "bomb.bin"=8)
    const honestView = new DataView(honestZip.buffer, honestZip.byteOffset, honestZip.byteLength);
    const compressedLen = honestView.getUint32(18, true);
    const deflatedPayload = honestZip.subarray(30 + 8, 30 + 8 + compressedLen);
    const forgedBombZip = buildCraftedZip([
      {
        cdPath: "bomb.bin",
        method: ZIP_METHOD_DEFLATE,
        payload: deflatedPayload,
        uncompressedSize: 16, // Lies in header!
        crc32: computeCrc32(largeZeros),
      },
    ]);
    await expect(unpackPgnaZip(forgedBombZip, { maxEntryBytes: 1024 })).rejects.toThrow(
      /exceeds maximum allowed size/,
    );

    // 4. Multi-disk ZIP rejected
    const multiDiskZip = buildCraftedZip(
      [{ cdPath: "a.txt", payload: utf8Encode("hi") }],
      { diskNumber: 1 },
    );
    await expect(unpackPgnaZip(multiDiskZip)).rejects.toThrow(/multi-disk/);

    // 5. Encrypted entry rejected
    const encryptedZip = buildCraftedZip([
      { cdPath: "secret.txt", payload: utf8Encode("hi"), flags: 0x0801 },
    ]);
    await expect(unpackPgnaZip(encryptedZip)).rejects.toThrow(/encrypted/);

    // 6. Unsafe directory entries rejected BEFORE skipping; safe directory entries allowed
    for (const unsafeDir of ["../../evil/", "/abs/", "/"]) {
      const badDirZip = buildCraftedZip([{ cdPath: unsafeDir, payload: new Uint8Array(0) }]);
      await expect(unpackPgnaZip(badDirZip)).rejects.toThrow(/Unsafe PGNA archive path/);
    }
    const safeDirZip = buildCraftedZip([
      { cdPath: "audio/", payload: new Uint8Array(0) },
      { cdPath: "audio/clip.ogg", payload: new Uint8Array([1, 2, 3]) },
    ]);
    const unpackedSafe = await unpackPgnaZip(safeDirZip);
    expect(unpackedSafe.map((e) => e.path)).toEqual(["audio/clip.ogg"]);

    // 7. LFH filename mismatch & LFH compression method mismatch rejected
    const badLfhNameZip = buildCraftedZip([
      { cdPath: "study.pgn", lfhPath: "other.pgn", payload: utf8Encode("1. e4 *") },
    ]);
    await expect(unpackPgnaZip(badLfhNameZip)).rejects.toThrow(/Local File Header filename/);

    const badLfhMethodZip = buildCraftedZip([
      { cdPath: "study.pgn", method: ZIP_METHOD_STORE, lfhMethod: ZIP_METHOD_DEFLATE, payload: utf8Encode("1. e4 *") },
    ]);
    await expect(unpackPgnaZip(badLfhMethodZip)).rejects.toThrow(/compression method/);

    // 8. Central Directory bounds overrun rejected
    const truncatedCdZip = buildCraftedZip(
      [{ cdPath: "study.pgn", payload: utf8Encode("1. e4 *") }],
      { cdSizeDelta: -4 },
    );
    await expect(unpackPgnaZip(truncatedCdZip)).rejects.toThrow(/Central Directory/);
  });

  it("supports forward-compatible additive properties in timeline.json (§2.2) and detects missing/stale merged timeline.vtt", async () => {
    const manifest = makeBaseManifest({
      defaultSubtitleLang: "en",
      clips: {
        c1: {
          id: "c1",
          path: "audio/c1.ogg",
          mimeType: "audio/ogg; codecs=opus",
          durationMs: 2000,
          subtitles: { en: "subtitles/en/c1.vtt" },
        },
      },
    });
    const packed = await packPgnaArchive({
      manifest,
      pgnText: "1. e4 { [%audio c1] [%at #1] } *",
      audioByPath: { "audio/c1.ogg": new Uint8Array([1, 2, 3, 4]) },
      subtitlesByPath: {
        "subtitles/en/c1.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nKing's pawn.",
      },
    });

    // Add unknown forward-compatible additive properties at multiple levels + different compiledAt
    const extendedTimeline = {
      ...packed.timeline,
      compiledAt: "2099-01-01T00:00:00.000Z",
      futureRootField: { version: 2 },
      games: packed.timeline.games.map((g) => ({ ...g, futureGameMeta: true })),
      entries: packed.timeline.entries.map((e) => ({
        ...e,
        waveformPeaks: [0.1, 0.5, 0.9],
        cues: e.cues.map((c) => ({ ...c, futureCueFlag: "ok" })),
      })),
      nodeIndex: Object.fromEntries(
        Object.entries(packed.timeline.nodeIndex).map(([k, v]) => [k, { ...v, futureNodeTag: 42 }]),
      ),
    };
    const extendedEntries = packed.entries.map((e) =>
      e.path === "timeline.json"
        ? { ...e, data: utf8Encode(JSON.stringify(extendedTimeline)) }
        : e,
    );
    expect(validatePgnaPackage(extendedEntries).valid).toBe(true);

    // Missing merged subtitles/en/timeline.vtt -> MISSING_ARCHIVE_ENTRY
    const missingMerged = packed.entries.filter((e) => e.path !== "subtitles/en/timeline.vtt");
    const missingRes = validatePgnaPackage(missingMerged);
    expect(missingRes.valid).toBe(false);
    expect(
      missingRes.diagnostics.some(
        (d) => d.code === "MISSING_ARCHIVE_ENTRY" && d.path === "subtitles/en/timeline.vtt",
      ),
    ).toBe(true);

    // Tampered merged subtitles/en/timeline.vtt -> STALE_SUBTITLES
    const staleMerged = packed.entries.map((e) =>
      e.path === "subtitles/en/timeline.vtt"
        ? { ...e, data: utf8Encode("WEBVTT\n\n00:00.000 --> 00:01.000\nTampered!\n") }
        : e,
    );
    const staleSubRes = validatePgnaPackage(staleMerged);
    expect(staleSubRes.valid).toBe(false);
    expect(
      staleSubRes.diagnostics.some(
        (d) => d.code === "STALE_SUBTITLES" && d.path === "subtitles/en/timeline.vtt",
      ),
    ).toBe(true);
  });

  it("round-trips unpacked subtitles without duplicate subtitles/<lang>/timeline.vtt entries (SPEC-1)", async () => {
    const manifest = makeBaseManifest({
      defaultSubtitleLang: "en",
      clips: {
        c1: {
          id: "c1",
          path: "audio/c1.ogg",
          mimeType: "audio/ogg; codecs=opus",
          durationMs: 2000,
          subtitles: { en: "subtitles/en/c1.vtt" },
        },
      },
    });
    const firstPack = await packPgnaArchive({
      manifest,
      pgnText: "1. e4 { [%audio c1] [%at #1] } *",
      audioByPath: { "audio/c1.ogg": new Uint8Array([9, 8, 7]) },
      subtitlesByPath: {
        "subtitles/en/c1.vtt": "WEBVTT\n\n00:00.000 --> 00:01.500\nFirst move.",
      },
    });

    const unpacked = await unpackPgnaArchive(firstPack.zipBytes);
    expect(unpacked.subtitlesByPath["subtitles/en/timeline.vtt"]).toBeDefined();

    // Re-pack passing unpacked.subtitlesByPath directly plus a stale unreferenced timeline.vtt
    const secondPack = await packPgnaArchive({
      manifest: unpacked.manifest,
      pgnText: unpacked.pgnText,
      audioByPath: unpacked.audioByPath,
      subtitlesByPath: {
        ...unpacked.subtitlesByPath,
        "subtitles/fr/timeline.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nStale FR",
      },
    });

    const mergedMatches = secondPack.entries.filter((e) => e.path === "subtitles/en/timeline.vtt");
    expect(mergedMatches).toHaveLength(1);
    expect(secondPack.entries.some((e) => e.path === "subtitles/fr/timeline.vtt")).toBe(false);
    expect((await validatePgnaZip(secondPack.zipBytes)).valid).toBe(true);
  });

  it("preserves WebVTT cues with NOTE-1 / STYLE-1 / REGION-1 / WEBVTT-1 identifiers", () => {
    const vtt = [
      "WEBVTT - Study Captions",
      "",
      "NOTE this is a comment block and should be skipped",
      "",
      "STYLE",
      "::cue { color: white; }",
      "",
      "NOTE-1",
      "00:00.000 --> 00:01.500",
      "Cue with NOTE-1 ID",
      "",
      "STYLE-2",
      "00:01.500 --> 00:03.000",
      "Cue with STYLE-2 ID",
    ].join("\n");

    expect(parseWebVtt(vtt)).toEqual([
      { startMs: 0, endMs: 1500, text: "Cue with NOTE-1 ID" },
      { startMs: 1500, endMs: 3000, text: "Cue with STYLE-2 ID" },
    ]);
  });
});

describe("@suite/pgna Phase 3 spec compliance fixes", () => {
  it("validates integer overflow in parsePgnaTimeMs, empty [%cal]/[%csl], infinite ordinals, and brace sanitization in formatNodeComment", () => {
    expect(parsePgnaTimeMs("12.5")).toBe(12500);
    expect(parsePgnaTimeMs("999999999999999")).toBeNull();
    expect(parsePgnaTimeMs("9999999999999:00:00")).toBeNull();
    expect(parsePgnaTimeMs("999999999999999:00")).toBeNull();

    const emptyTags = parseNodeComments(["[%cal] [%csl] [%cue 1.0 cal= csl=]"]);
    expect(emptyTags.diagnostics.some((d) => d.code === "INVALID_CAL_TAG")).toBe(true);
    expect(emptyTags.diagnostics.some((d) => d.code === "INVALID_CSL_TAG")).toBe(true);
    // [%cue] cal= and csl= clearing still accepted cleanly
    expect(emptyTags.tags.cues).toHaveLength(1);

    const hugeOrd = parseNodeComments([`[%at #${"9".repeat(400)}]`]);
    expect(hugeOrd.diagnostics.some((d) => d.code === "INVALID_AT_TAG")).toBe(true);

    const formatted = formatNodeComment({
      ...emptyTags.tags,
      prose: "Check {nested} braces!",
    });
    expect(formatted).not.toContain("{");
    expect(formatted).not.toContain("}");
    expect(formatted).toContain("Check nested braces!");
  });

  it("enforces [Variant] header, warns on invalid [Orientation], tracks siblingIndex, defers visitedNodes on 0-duration, and fixes branchTimeline dur= & CUE_OUT_OF_BOUNDS deduplication", () => {
    // 1. [Variant "Chess960"] -> UNSUPPORTED_VARIANT error and skip compiling moves
    const chess960 = compilePgna({
      manifest: makeBaseManifest(),
      pgnText: '[Variant "Chess960"]\n\n1. e4 { [%at #1] } *',
    });
    expect(chess960.diagnostics.some((d) => d.code === "UNSUPPORTED_VARIANT")).toBe(true);
    expect(chess960.timeline.entries).toHaveLength(0);

    // [Variant "Standard"] succeeds
    const standard = compilePgna({
      manifest: makeBaseManifest(),
      pgnText: '[Variant "Standard"]\n\n1. e4 { [%at #1] } *',
    });
    expect(standard.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(standard.timeline.entries).toHaveLength(1);

    // 2. Invalid [Orientation] warning
    const badOrient = compilePgna({
      manifest: makeBaseManifest(),
      pgnText: '[Orientation "sideways"]\n\n1. e4 { [%at #1] } *',
    });
    expect(badOrient.diagnostics.some((d) => d.code === "INVALID_ORIENTATION_HEADER")).toBe(true);
    expect(badOrient.timeline.games[0]?.orientation).toBe("white");

    // 3. Illegal mainline move must NOT promote sibling RAV (siblingIndex 1) to isMainline: true
    const illegalMainlineGuess = compilePgna({
      manifest: makeBaseManifest(),
      pgnText: "1. e4 { [%at #1] [%guess] } 1... Qxe8 (1... e5) *",
    });
    expect(illegalMainlineGuess.diagnostics.some((d) => d.code === "ILLEGAL_MOVE")).toBe(true);
    const guessBranches = illegalMainlineGuess.timeline.guesses?.["g0/0"]?.branches ?? [];
    expect(guessBranches).toHaveLength(1);
    expect(guessBranches[0]?.san).toBe("e5");
    expect(guessBranches[0]?.isMainline).toBe(false);

    // 4. Failed 0-duration primary occurrence does NOT turn second occurrence into an orphan revisit
    const zeroDur = compilePgna({
      manifest: makeBaseManifest(),
      pgnText: "1. e4 { [%at #1 dur=0] [%at #2 dur=1.5] } *",
    });
    expect(zeroDur.diagnostics.some((d) => d.code === "ZERO_ENTRY_DURATION")).toBe(true);
    expect(zeroDur.timeline.entries).toHaveLength(1);
    expect(zeroDur.timeline.entries[0]?.isRevisit).toBeUndefined();
    expect(zeroDur.timeline.entries[0]?.endMs).toBe(1500);

    // 5. branchTimeline resolves primary [%at] dur= and deduplicates CUE_OUT_OF_BOUNDS
    const branchDurAndCue = compilePgna({
      manifest: makeBaseManifest({
        compilation: { defaultSilentDurationMs: 1000 },
      }),
      pgnText: `
        1. e4 { [%at #1] [%guess] }
        1... e5 { [%at #4 dur=0.5] [%at #2 dur=2.5] [%dur 3.0] [%cue 5.0 clear] }
        (1... c5 { [%at #3 dur=1.8] [%cue 4.0 clear] })
        *
      `,
    });
    const gSpec = branchDurAndCue.timeline.guesses?.["g0/0"];
    expect(gSpec).toBeDefined();
    // Earliest [%at] on e5 is #2 with dur=2.5 (2500ms), NOT #4 (500ms) and NOT [%dur 3.0]
    const e5Branch = gSpec?.branches.find((b) => b.san === "e5");
    expect(e5Branch?.branchDurationMs).toBe(2500);
    const c5Branch = gSpec?.branches.find((b) => b.san === "c5");
    expect(c5Branch?.branchDurationMs).toBe(1800);

    // Each node with out-of-bounds cue emits CUE_OUT_OF_BOUNDS at most ONCE (no duplicate from branchTimeline)
    const oobForE5 = branchDurAndCue.diagnostics.filter(
      (d) => d.code === "CUE_OUT_OF_BOUNDS" && d.nodeId === "g0/0.0",
    );
    const oobForC5 = branchDurAndCue.diagnostics.filter(
      (d) => d.code === "CUE_OUT_OF_BOUNDS" && d.nodeId === "g0/0.1",
    );
    expect(oobForE5).toHaveLength(1);
    expect(oobForC5).toHaveLength(1);
  });

  it("rejects wrong promotion piece on guess moves (SPEC-2), guards non-finite player times, and uses merged subtitles exclusively in timeline mode", () => {
    // 1. Promotion guess test: White pawn on e7, mainline promotion is e8=Q!
    const promoPgn = `
      [SetUp "1"]
      [FEN "7k/4P3/8/8/8/8/8/4K3 w - - 0 1"]
      { Promote! [%at #1] [%guess] }
      1. e8=Q+! { Queen promotion [%at #2] }
      *
    `;
    const compiledPromo = compilePgna({
      manifest: makeBaseManifest({ compilation: { defaultSilentDurationMs: 1000 } }),
      pgnText: promoPgn,
    });
    expect(compiledPromo.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    const promoPlayer = createPgnaPlayer(compiledPromo.timeline);
    promoPlayer.play();
    promoPlayer.tick(1000);
    expect(promoPlayer.getSnapshot().guessPhase).toBe("awaiting");

    // Underpromotion to knight on same squares e7->e8 MUST be rejected as unlisted!
    const wrongPromo = promoPlayer.submitGuessMove("e7", "e8", "n");
    expect(wrongPromo).toEqual({ status: "unlisted", matchedBranchNodeId: null });
    expect(promoPlayer.getSnapshot().guessPhase).toBe("awaiting");

    // Matching queen promotion succeeds
    const rightPromo = promoPlayer.submitGuessMove("e7", "e8", "q");
    expect(rightPromo).toEqual({ status: "success", matchedBranchNodeId: "g0/0" });

    // 2. Non-finite tick / seek / setManualClipTime are safe no-ops
    const subManifest = makeBaseManifest({
      defaultSubtitleLang: "en",
      clips: {
        c1: {
          id: "c1",
          path: "audio/c1.ogg",
          mimeType: "audio/ogg; codecs=opus",
          durationMs: 4000,
          trimStartMs: 0,
          trimEndMs: 4000,
          subtitles: { en: "subtitles/en/c1.vtt" },
        },
      },
    });
    const compiledSub = compilePgna({
      manifest: subManifest,
      pgnText: "1. e4 { [%audio c1] [%at #1] } *",
      subtitlesByPath: {
        "subtitles/en/c1.vtt": "WEBVTT\n\n00:00.000 --> 00:01.000\nOpening line\n",
      },
    });
    const subPlayer = createPgnaPlayer(compiledSub.timeline, {
      subtitleLang: "en",
      subtitlesByPath: {
        // Deliberately supply a raw per-clip VTT that has a cue at 2.5s, while merged VTT has a gap at 2.5s
        "subtitles/en/c1.vtt": "WEBVTT\n\n00:00.000 --> 00:04.000\nRaw fallback should NOT appear\n",
        "subtitles/en/timeline.vtt": compiledSub.mergedSubtitlesVtt["subtitles/en/timeline.vtt"]!,
      },
    });

    subPlayer.seek(500);
    expect(subPlayer.getSnapshot().activeSubtitle).toBe("Opening line");
    // At 2500ms, merged timeline.vtt is silent -> MUST be null (no fallback to raw per-clip .vtt)
    subPlayer.seek(2500);
    expect(subPlayer.getSnapshot().activeSubtitle).toBeNull();

    // Non-finite guards
    subPlayer.play();
    subPlayer.tick(Number.NaN);
    subPlayer.tick(Number.POSITIVE_INFINITY);
    expect(subPlayer.getSnapshot().globalTimeMs).toBe(2500);

    subPlayer.seek(Number.NaN);
    subPlayer.seek(Number.NEGATIVE_INFINITY);
    expect(subPlayer.getSnapshot().globalTimeMs).toBe(2500);

    subPlayer.selectNode("g0/0");
    subPlayer.setManualClipTime(500);
    subPlayer.setManualClipTime(Number.NaN);
    subPlayer.setManualClipTime(Number.POSITIVE_INFINITY);
    subPlayer.play();
    expect(subPlayer.getSnapshot().audioTimeMs).toBe(500);
  });
});
