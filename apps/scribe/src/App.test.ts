import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parsePgnGames, serializePgnGames } from "@suite/chess-core";
import { compilePgna } from "@suite/pgna";
import { App } from "./App";
import {
  deleteLocalDraft,
  listLocalDrafts,
  loadLocalDraft,
  saveLocalDraft,
} from "./local/draftStore";
import { createBlankDraft, createDemoItalianDraft } from "./local/draftWorkspace";
import {
  addNewGame,
  appendNodeToTimeline,
  collectReferencedClipIds,
  deleteNodeSubtree,
  detectStudyTimingMode,
  indexStudyGames,
  playMoveAtNode,
  promoteVariation,
  reorderTimelineEntries,
  toggleBoardArrow,
  toggleBoardHighlight,
  toggleNodeNag,
  updateAtTagDuration,
  updateNodeTags,
} from "./local/studyTree";

describe("@suite/scribe studio", () => {
  it("renders local-first PGNA v1.0 authoring studio, ChessBoard, and compiled timeline", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("PGNA v1.0");
    expect(html).toContain('data-testid="chess-board"');
    expect(html).toContain("Italian Game Essentials");
    expect(html).toContain("Compiled Linear Timeline");
    expect(html).toContain("↩ Return");
    expect(html).toContain('id="nav-sign-in"');
    expect(html).toContain("Lecture");
  });

  it("supports branching variations, promotion, annotations, silent return pauses, and timeline reordering", () => {
    const draft = createBlankDraft("Sicilian Lesson");
    let games = parsePgnGames(draft.pgnText);

    // Play 1. e4 e5 and branch 1... c5
    const m1 = playMoveAtNode(games, "g0", { from: "e2", to: "e4" })!;
    expect(m1.nextNodeId).toBe("g0/0");
    games = m1.games;

    const m2 = playMoveAtNode(games, "g0/0", { from: "e7", to: "e5" })!;
    expect(m2.nextNodeId).toBe("g0/0.0");
    games = m2.games;

    const mVar = playMoveAtNode(games, "g0/0", { from: "c7", to: "c5" })!;
    expect(mVar.nextNodeId).toBe("g0/0.1");
    games = mVar.games;

    // Annotate 1. e4 with arrow, highlight, and NAG
    games = toggleBoardArrow(games, "g0/0", "e2", "e4", "G");
    games = toggleBoardHighlight(games, "g0/0", "e4", "Y");
    games = toggleNodeNag(games, "g0/0", "$1");

    // Schedule 1. e4 (#1), variation 1... c5 (#2), silent return pause to 1. e4 (#3), and 1... e5 (#4)
    games = appendNodeToTimeline(games, "g0/0");
    games = appendNodeToTimeline(games, "g0/0.1");
    games = appendNodeToTimeline(games, "g0/0", 750);
    games = appendNodeToTimeline(games, "g0/0.0");

    // Update revisit duration on 2nd [%at] tag of g0/0
    games = updateAtTagDuration(games, "g0/0", 1, 1200);

    const compiled = compilePgna({
      manifest: draft.manifest,
      pgnText: serializePgnGames(games),
    });

    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(compiled.timeline.entries).toHaveLength(4);
    expect(compiled.timeline.entries[2]?.nodeId).toBe("g0/0");
    expect(compiled.timeline.entries[2]?.isRevisit).toBe(true);
    expect(compiled.timeline.entries[2]?.audio).toBeNull();
    expect(
      (compiled.timeline.entries[2]?.endMs ?? 0) - (compiled.timeline.entries[2]?.startMs ?? 0),
    ).toBe(1200);

    // Reorder timeline entry 3 (1... e5) before entry 2 (silent return)
    const reorderedGames = reorderTimelineEntries(games, compiled.timeline.entries, 3, 2);
    const recompiled = compilePgna({
      manifest: draft.manifest,
      pgnText: serializePgnGames(reorderedGames),
    });
    expect(recompiled.timeline.entries.map((e) => e.nodeId)).toEqual([
      "g0/0",
      "g0/0.1",
      "g0/0.0",
      "g0/0",
    ]);

    // Promote 1... c5 to mainline and verify tree
    const promoted = promoteVariation(games, "g0/0.1");
    expect(promoted.nextNodeId).toBe("g0/0.0");
    const idx = indexStudyGames(promoted.games);
    expect(idx.nodesById["g0/0.0"]?.san).toBe("c5");

    // Delete variation 1... e5 (now at g0/0.1)
    const deleted = deleteNodeSubtree(promoted.games, "g0/0.1");
    expect(deleted.fallbackNodeId).toBe("g0/0");
    expect(indexStudyGames(deleted.games).nodesById["g0/0"]?.childIds).toEqual(["g0/0.0"]);
  });

  it("persists local drafts via draftStore fallback cleanly", async () => {
    const demo = createDemoItalianDraft();
    await saveLocalDraft(demo);

    const loaded = await loadLocalDraft(demo.id);
    expect(loaded?.manifest.title).toBe("Italian Game Essentials");

    const list = await listLocalDrafts();
    expect(list.some((d) => d.id === demo.id)).toBe(true);

    await deleteLocalDraft(demo.id);
    expect(await loadLocalDraft(demo.id)).toBeNull();
  });

  it("transitions TimelineAudioEngine cleanly across clip 1 -> clip 2 -> silent revisit -> clip 3", async () => {
    const started: Array<{ label: string; offset: number; duration: number; stopped: boolean }> = [];
    let mockNowSec = 0;

    class FakeAudioContext {
      state: AudioContextState = "suspended";
      destination = {};
      get currentTime() {
        return mockNowSec;
      }
      resume() {
        this.state = "running";
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
      decodeAudioData(buf: ArrayBuffer) {
        const tag = new Uint8Array(buf)[0];
        return Promise.resolve({ duration: 4.0, label: `clip-${tag}` } as unknown as AudioBuffer);
      }
      createBufferSource() {
        let record: { label: string; offset: number; duration: number; stopped: boolean } | null =
          null;
        return {
          buffer: null as unknown as { label: string } | null,
          onended: null as (() => void) | null,
          connect() {},
          disconnect() {},
          start(_when: number, offset: number, duration: number) {
            record = {
              label: this.buffer?.label ?? "unknown",
              offset,
              duration,
              stopped: false,
            };
            started.push(record);
          },
          stop() {
            if (record) record.stopped = true;
          },
        };
      }
    }

    const origAudioCtx = (globalThis as Record<string, unknown>)["AudioContext"];
    (globalThis as Record<string, unknown>)["AudioContext"] = FakeAudioContext;

    try {
      const { createTimelineAudioEngine } = await import("./local/audioPlaybackEngine");
      const engine = createTimelineAudioEngine(
        {
          "audio/c1.ogg": new Uint8Array([1]),
          "audio/c2.ogg": new Uint8Array([2]),
          "audio/c3.ogg": new Uint8Array([3]),
        },
        {
          c1: { id: "c1", path: "audio/c1.ogg", mimeType: "audio/ogg", durationMs: 2000 },
          c2: { id: "c2", path: "audio/c2.ogg", mimeType: "audio/ogg", durationMs: 2500 },
          c3: { id: "c3", path: "audio/c3.ogg", mimeType: "audio/ogg", durationMs: 1800 },
        },
      );

      // Wait a microtask for eager pre-decoding
      await Promise.resolve();
      await Promise.resolve();

      engine.unlock();

      // Clip 1 starts at 0ms
      const c1 = {
        clipId: "c1",
        path: "audio/c1.ogg",
        mimeType: "audio/ogg",
        durationMs: 2000,
        trimStartMs: 0,
        trimEndMs: 2000,
      };
      engine.sync(true, c1, 0);
      mockNowSec = 0.5;
      engine.sync(true, c1, 500);
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ label: "clip-1", offset: 0, duration: 2, stopped: false });

      // Seamless transition to Clip 2 (zero gap!)
      const c2 = {
        clipId: "c2",
        path: "audio/c2.ogg",
        mimeType: "audio/ogg",
        durationMs: 2500,
        trimStartMs: 200,
        trimEndMs: 2500,
      };
      mockNowSec = 2.01;
      engine.sync(true, c2, 210);
      expect(started[0]?.stopped).toBe(true);
      expect(started).toHaveLength(2);
      expect(started[1]).toMatchObject({
        label: "clip-2",
        offset: 0.21,
        stopped: false,
      });

      // Silent revisit pause -> stops Clip 2 and emits no new source
      mockNowSec = 4.35;
      engine.sync(true, null, null);
      expect(started[1]?.stopped).toBe(true);
      expect(started).toHaveLength(2);

      // Transition to Clip 3 after silent revisit -> starts Clip 3 cleanly
      const c3 = {
        clipId: "c3",
        path: "audio/c3.ogg",
        mimeType: "audio/ogg",
        durationMs: 1800,
        trimStartMs: 0,
        trimEndMs: 1800,
      };
      mockNowSec = 5.35;
      engine.sync(true, c3, 15);
      expect(started).toHaveLength(3);
      expect(started[2]).toMatchObject({
        label: "clip-3",
        offset: 0.015,
        stopped: false,
      });

      engine.dispose();
      expect(started[2]?.stopped).toBe(true);
    } finally {
      if (origAudioCtx === undefined) {
        delete (globalThis as Record<string, unknown>)["AudioContext"];
      } else {
        (globalThis as Record<string, unknown>)["AudioContext"] = origAudioCtx;
      }
    }
  });

  it("preserves explicit-timestamp scheduling mode without MIXED_TIMELINE_MODES, preserves player headers, and tracks referenced clips", () => {
    const draft = createBlankDraft("Timestamp Study");
    let games = parsePgnGames('1. e4 { [%at 0] } 1... e5 { [%at 3.5] } 2. Nf3 *');
    expect(detectStudyTimingMode(games)).toBe("timestamp");

    games = appendNodeToTimeline(games, "g0/0.0.0", undefined, { nextTimestampMs: 5000 });
    const compiled = compilePgna({
      manifest: draft.manifest,
      pgnText: serializePgnGames(games),
    });
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
    expect(compiled.timeline.entries).toHaveLength(3);
    expect(compiled.timeline.entries[2]?.startMs).toBe(5000);

    // addNewGame preserves White and Black player headers
    const added = addNewGame(games, "Chapter 2", undefined, {
      white: "Kasparov",
      black: "Karpov",
    });
    expect(added.games[1]?.headers["White"]).toBe("Kasparov");
    expect(added.games[1]?.headers["Black"]).toBe("Karpov");

    // collectReferencedClipIds tracks audio references across games and drops deleted subtrees
    let withAudio = updateNodeTags(added.games, "g0/0", (tags) => ({
      ...tags,
      audioClipId: "clip-001",
    }));
    withAudio = updateNodeTags(withAudio, "g0/0.0", (tags) => ({
      ...tags,
      audioClipId: "clip-002",
    }));
    expect([...collectReferencedClipIds(withAudio)].sort()).toEqual(["clip-001", "clip-002"]);

    const deleted = deleteNodeSubtree(withAudio, "g0/0.0");
    expect([...collectReferencedClipIds(deleted.games)]).toEqual(["clip-001"]);
  });

  it("restarts playback in TimelineAudioEngine when seeking backward after source.onended", async () => {
    const sources: Array<{ offset: number; onended: (() => void) | null }> = [];
    let mockNowSec = 0;

    class FakeAudioContext {
      state: AudioContextState = "running";
      destination = {};
      get currentTime() {
        return mockNowSec;
      }
      resume() {
        return Promise.resolve();
      }
      close() {
        return Promise.resolve();
      }
      decodeAudioData() {
        return Promise.resolve({ duration: 1.8 } as unknown as AudioBuffer);
      }
      createBufferSource() {
        const src = {
          buffer: null as unknown as AudioBuffer | null,
          onended: null as (() => void) | null,
          connect() {},
          disconnect() {},
          start(_when: number, offset: number) {
            sources.push({
              offset,
              get onended() {
                return src.onended;
              },
              set onended(fn) {
                src.onended = fn;
              },
            });
          },
          stop() {},
        };
        return src;
      }
    }

    const origAudioCtx = (globalThis as Record<string, unknown>)["AudioContext"];
    (globalThis as Record<string, unknown>)["AudioContext"] = FakeAudioContext;

    try {
      const { createTimelineAudioEngine } = await import("./local/audioPlaybackEngine");
      const engine = createTimelineAudioEngine(
        { "audio/c1.ogg": new Uint8Array([1]) },
        { c1: { id: "c1", path: "audio/c1.ogg", mimeType: "audio/ogg", durationMs: 2000 } },
      );

      await Promise.resolve();
      await Promise.resolve();

      const c1 = {
        clipId: "c1",
        path: "audio/c1.ogg",
        mimeType: "audio/ogg",
        durationMs: 2000,
        trimStartMs: 0,
        trimEndMs: 2000,
      };

      engine.sync(true, c1, 0);
      expect(sources).toHaveLength(1);

      // Buffer finishes early (1.8s < 2.0s) and fires onended
      mockNowSec = 1.8;
      sources[0]?.onended?.();

      // User scrubs backward to 0.2s within the same clip while still playing
      mockNowSec = 1.85;
      engine.sync(true, c1, 200);
      expect(sources).toHaveLength(2);
      expect(sources[1]?.offset).toBeCloseTo(0.2, 3);

      engine.dispose();
    } finally {
      if (origAudioCtx === undefined) {
        delete (globalThis as Record<string, unknown>)["AudioContext"];
      } else {
        (globalThis as Record<string, unknown>)["AudioContext"] = origAudioCtx;
      }
    }
  });

  it("UI-02 & UI-03: preserves full elapsed frame delta across suspension and renders accessible dialogs & associated textarea labels", async () => {
    const { computePlaybackFrameDeltaMs } = await import("./components/PreviewPlayer");
    // A 1500ms frame suspension advances by full 1500ms rather than clamping to 100ms
    expect(computePlaybackFrameDeltaMs(1000, 2500)).toBe(1500);
    expect(computePlaybackFrameDeltaMs(2500, 2400)).toBe(0);
    expect(computePlaybackFrameDeltaMs(Number.NaN, 2500)).toBe(0);

    const { DraftsModal } = await import("./components/DraftsModal");
    const { PublishModal } = await import("./publish/PublishModal");
    const { INITIAL_PUBLISH_JOB_STATE } = await import("./publish/kibitzPublisher");

    const draftsHtml = renderToStaticMarkup(
      createElement(DraftsModal, {
        open: true,
        activeDraftId: "d1",
        drafts: [],
        onClose: () => undefined,
        onCreateBlank: () => undefined,
        onLoadDemo: () => undefined,
        onOpenDraft: () => undefined,
        onDeleteDraft: () => undefined,
      }),
    );
    expect(draftsHtml).toContain('role="dialog"');
    expect(draftsHtml).toContain('aria-modal="true"');
    expect(draftsHtml).toContain('aria-labelledby="scribe-drafts-dialog-title"');
    expect(draftsHtml).toContain('id="scribe-drafts-dialog-title"');

    const demoDraft = createBlankDraft("Accessible Dialog Test");
    const publishHtml = renderToStaticMarkup(
      createElement(PublishModal, {
        open: true,
        manifest: demoDraft.manifest,
        sessionUser: null,
        publishState: INITIAL_PUBLISH_JOB_STATE,
        onStartPublish: async () => ({ published: false, message: "test" }),
        onResetPublishResult: () => undefined,
        onSessionChange: () => undefined,
        onClose: () => undefined,
        onExportLocalPgna: () => undefined,
      }),
    );
    expect(publishHtml).toContain('role="dialog"');
    expect(publishHtml).toContain('aria-modal="true"');
    expect(publishHtml).toContain('aria-labelledby="scribe-publish-dialog-title"');
    expect(publishHtml).toContain('id="scribe-publish-dialog-title"');
  });
});

