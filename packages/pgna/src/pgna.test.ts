import { describe, expect, it } from "vitest";
import {
  ZIP_METHOD_DEFLATE,
  ZIP_METHOD_STORE,
  compilePgna,
  createPgnaPlayer,
  isSafeArchivePath,
  isValidClipId,
  isValidNodeId,
  prepareArchiveEntries,
  validatePgnaArchive,
} from "./index.js";

describe("@suite/pgna contracts", () => {
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

  it("provides working compiler and player stubs", () => {
    const compiled = compilePgna({
      manifest: {
        format: "pgna",
        version: "1.0",
        pgnPath: "study.pgn",
        timelinePath: "timeline.json",
        clips: {},
      },
      pgnText: "1. e4 e5 *",
    });
    const player = createPgnaPlayer(compiled.timeline);
    expect(player.getSnapshot().mode).toBe("timeline");
    player.selectNode("g0/0");
    expect(player.getSnapshot().mode).toBe("manual");
  });
});
