import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePgnGames, serializePgnGames } from "@suite/chess-core";
import {
  PGNA_FORMAT_VERSION,
  PgnaPackError,
  compilePgna,
  packPgnaZip,
  prepareArchiveEntries,
  unpackPgnaArchive,
  utf8Encode,
  validatePgnaZip,
  type ClipDefinition,
  type NodeId,
} from "@suite/pgna";
import {
  decodeAudioMetadata,
  startMicRecording,
  type ActiveRecordingSession,
} from "./local/audioStudio";
import {
  clearMemoryDraftFallbackForTests,
  getDraftStorageMode,
  listLocalDrafts,
  loadLocalDraft,
  saveLocalDraft,
} from "./local/draftStore";
import { createBlankDraft, createDemoItalianDraft, type ScribeDraft } from "./local/draftWorkspace";
import { playMoveAtNode, updateNodeTags } from "./local/studyTree";
import {
  applyAudioClipAttachment,
  applySubtitleUpdate,
  buildImportedPgnaDraft,
  buildValidatedPgnaArchive,
  createRawPgnBuffer,
  createWorkspaceController,
  deriveRawPgnView,
  editRawPgnBuffer,
  formatPgnaExportError,
  formatSaveStatus,
  formatSaveStatusForMode,
  runCancelMicRecording,
  runStartMicRecording,
  runStopMicRecording,
  type MicRecordingStateAdapter,
  type MicRecordingTarget,
} from "./local/workspaceTransitions";
import {
  MAX_PUBLISH_DESCRIPTION_LENGTH,
  MAX_PUBLISH_TAGS,
  MAX_PUBLISH_TITLE_LENGTH,
  createPublishSessionController,
  mergePendingTagInput,
  validatePublishMetadata,
} from "./publish/kibitzPublisher";

type GlobalRecord = Record<string, unknown>;

const restorers: Array<() => void> = [];

function setGlobal(key: string, value: unknown): void {
  const g = globalThis as GlobalRecord;
  const hadOwn = Object.prototype.hasOwnProperty.call(g, key);
  const previousDescriptor = Object.getOwnPropertyDescriptor(g, key);
  if (value === undefined) {
    delete g[key];
  } else {
    Object.defineProperty(g, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }
  restorers.push(() => {
    if (hadOwn && previousDescriptor) {
      Object.defineProperty(g, key, previousDescriptor);
    } else {
      delete g[key];
    }
  });
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  while (restorers.length > 0) {
    restorers.pop()?.();
  }
  clearMemoryDraftFallbackForTests();
  vi.useRealTimers();
});

// ============================================================================
// SCR-01 · Unified workspace transitions, flush-before-switch, monotonic gen,
//          and honest durability status
// ============================================================================

describe("SCR-01 · workspace transitions and persistence honesty", () => {
  it("flushes dirty edits before switching to Open / New / Demo / Import before the 500ms debounce", async () => {
    vi.useFakeTimers();

    let activeDraft = createBlankDraft("Draft A");
    const statusHistory: string[] = [];

    const controller = createWorkspaceController({
      getDraft: () => activeDraft,
      setDraft: (next) => {
        activeDraft = next;
      },
      saveDraft: saveLocalDraft,
      getStorageMode: getDraftStorageMode,
      debounceMs: 500,
      onSaveStatus: (s) => statusHistory.push(s),
    });

    // Save Draft B so we can switch to it later
    const draftB = createBlankDraft("Draft B");
    await saveLocalDraft(draftB);

    // Edit Draft A and immediately switch to Draft B BEFORE 500ms debounce elapses
    activeDraft = {
      ...activeDraft,
      pgnText: '[Event "Draft A"]\n[Result "*"]\n\n1. e4 { Unflushed edit } *',
    };
    const draftAId = activeDraft.id;
    controller.markDirty();
    expect(controller.isDirty()).toBe(true);
    expect(statusHistory.at(-1)).toBe(formatSaveStatus("pending"));

    // Switch to Draft B immediately (0ms elapsed)
    const openRes = await controller.transitionWorkspace(async () => {
      const loaded = await loadLocalDraft(draftB.id);
      return loaded ? { draft: loaded, dirty: false } : null;
    });
    expect(openRes.status).toBe("committed");
    expect(activeDraft.id).toBe(draftB.id);

    // Reopen Draft A and verify the edit was flushed prior to replacement
    const reopenedA = await loadLocalDraft(draftAId);
    expect(reopenedA?.pgnText).toContain("Unflushed edit");

    // Edit Draft B, immediately switch to New Blank -> Draft B edit must be flushed
    activeDraft = {
      ...activeDraft,
      pgnText: '[Event "Draft B"]\n[Result "*"]\n\n1. d4 { Draft B edit } *',
    };
    controller.markDirty();
    const blankDraft = createBlankDraft("Draft C");
    const newRes = await controller.transitionWorkspace(() => ({
      draft: blankDraft,
      dirty: true,
    }));
    expect(newRes.status).toBe("committed");
    expect(activeDraft.id).toBe(blankDraft.id);
    expect((await loadLocalDraft(draftB.id))?.pgnText).toContain("Draft B edit");

    // Edit Draft C, immediately switch to Demo -> Draft C must be flushed
    activeDraft = {
      ...activeDraft,
      pgnText: '[Event "Draft C"]\n[Result "*"]\n\n1. c4 { Draft C edit } *',
    };
    controller.markDirty();
    const demoRes = await controller.transitionWorkspace(() => ({
      draft: createDemoItalianDraft(),
      dirty: false,
      saveStatusState: "idle-demo",
    }));
    expect(demoRes.status).toBe("committed");
    expect((await loadLocalDraft(blankDraft.id))?.pgnText).toContain("Draft C edit");

    // Edit Demo, immediately switch via Import -> Demo edit must be flushed
    activeDraft = {
      ...activeDraft,
      pgnText: '[Event "Demo Edited"]\n[Result "*"]\n\n1. Nf3 { Demo edit } *',
    };
    const editedDemoId = activeDraft.id;
    controller.markDirty();
    const importedDraft = createBlankDraft("Imported Study");
    const importRes = await controller.transitionWorkspace(() => ({
      draft: importedDraft,
      dirty: true,
    }));
    expect(importRes.status).toBe("committed");
    expect(activeDraft.id).toBe(importedDraft.id);
    expect((await loadLocalDraft(editedDemoId))?.pgnText).toContain("Demo edit");

    controller.dispose();
  });

  it("aborts workspace switch when flush save fails, keeping outgoing draft intact and reporting failed status", async () => {
    const outgoing = createBlankDraft("Unsaved Draft A");
    outgoing.pgnText = '[Event "Draft A"]\n[Result "*"]\n\n1. e4 { Must not be lost } *';
    let activeDraft: ScribeDraft = outgoing;
    const statusHistory: string[] = [];
    const errors: unknown[] = [];

    const controller = createWorkspaceController({
      getDraft: () => activeDraft,
      setDraft: (next) => {
        activeDraft = next;
      },
      saveDraft: async () => {
        throw new Error("QuotaExceededError");
      },
      getStorageMode: () => "indexeddb",
      onSaveStatus: (s) => statusHistory.push(s),
      onSaveError: (err) => errors.push(err),
    });

    controller.markDirty();
    const loaderSpy = vi.fn(() => ({ draft: createBlankDraft("Replacement"), dirty: true }));

    const result = await controller.transitionWorkspace(loaderSpy);

    expect(result.status).toBe("aborted-save-failed");
    expect(loaderSpy).not.toHaveBeenCalled();
    expect(activeDraft.id).toBe(outgoing.id);
    expect(activeDraft.pgnText).toContain("Must not be lost");
    expect(controller.isDirty()).toBe(true);
    expect(statusHistory.at(-1)).toBe("Save failed — export .pgna to keep");
    expect(errors).toHaveLength(1);

    controller.dispose();
  });

  it("ignores stale async openDraft completion when a newer workspace selection finishes first", async () => {
    let activeDraft = createBlankDraft("Initial");
    const slowOpen = createDeferred<ScribeDraft>();
    const fastOpen = createDeferred<ScribeDraft>();

    const draftSlow = createBlankDraft("Older Slow Open");
    const draftFast = createBlankDraft("Newer Fast Open");

    const controller = createWorkspaceController({
      getDraft: () => activeDraft,
      setDraft: (next) => {
        activeDraft = next;
      },
      saveDraft: saveLocalDraft,
      getStorageMode: () => "indexeddb",
      onSaveStatus: () => undefined,
    });

    // Launch older open, then launch newer open while older is still in flight
    const pSlow = controller.transitionWorkspace(async () => ({
      draft: await slowOpen.promise,
      dirty: false,
    }));
    const pFast = controller.transitionWorkspace(async () => ({
      draft: await fastOpen.promise,
      dirty: false,
    }));

    // Newer open resolves first and commits
    fastOpen.resolve(draftFast);
    const fastRes = await pFast;
    expect(fastRes.status).toBe("committed");
    expect(activeDraft.id).toBe(draftFast.id);

    // Older open resolves later and must be discarded as stale
    slowOpen.resolve(draftSlow);
    const slowRes = await pSlow;
    expect(slowRes.status).toBe("stale");
    expect(activeDraft.id).toBe(draftFast.id);

    controller.dispose();
  });

  it("never reports 'Saved locally (IndexedDB)' when storage falls back to memory-only mode", async () => {
    setGlobal("indexedDB", undefined);
    expect(getDraftStorageMode()).toBe("memory");

    let activeDraft = createBlankDraft("Memory Session Draft");
    const statuses: string[] = [];

    const controller = createWorkspaceController({
      getDraft: () => activeDraft,
      setDraft: (next) => {
        activeDraft = next;
      },
      saveDraft: saveLocalDraft,
      getStorageMode: getDraftStorageMode,
      onSaveStatus: (s) => statuses.push(s),
    });

    controller.markDirty();
    const ok = await controller.flushPendingSave();
    expect(ok).toBe(true);

    expect(statuses.at(-1)).toBe("Session only (memory — export .pgna to keep)");
    expect(statuses.some((s) => s.includes("IndexedDB"))).toBe(false);
    expect(formatSaveStatusForMode("memory")).toBe("Session only (memory — export .pgna to keep)");
    expect(formatSaveStatusForMode("indexeddb")).toBe("Saved locally (IndexedDB)");

    controller.dispose();
  });

  it("preserves dirty state if a newer edit arrives while a previous save is still in flight", async () => {
    let activeDraft = createBlankDraft("Concurrent Edit Draft");
    const firstSaveGate = createDeferred<{ mode: "indexeddb"; updatedAt: string }>();
    const savedSnapshots: string[] = [];

    const controller = createWorkspaceController({
      getDraft: () => activeDraft,
      setDraft: (next) => {
        activeDraft = next;
      },
      saveDraft: async (draft) => {
        savedSnapshots.push(draft.pgnText);
        if (savedSnapshots.length === 1) {
          return firstSaveGate.promise;
        }
        return { mode: "indexeddb", updatedAt: new Date().toISOString() };
      },
      getStorageMode: () => "indexeddb",
      onSaveStatus: () => undefined,
    });

    activeDraft = { ...activeDraft, pgnText: "1. e4 *" };
    controller.markDirty();
    const flushPromise = controller.flushPendingSave();

    // Wait a microtask so save #1 starts, then perform edit #2
    await Promise.resolve();
    activeDraft = { ...activeDraft, pgnText: "1. e4 1... e5 *" };
    controller.markDirty();

    firstSaveGate.resolve({ mode: "indexeddb", updatedAt: new Date().toISOString() });
    const flushed = await flushPromise;

    expect(flushed).toBe(true);
    expect(controller.isDirty()).toBe(false);
    expect(savedSnapshots).toEqual(["1. e4 *", "1. e4 1... e5 *"]);

    controller.dispose();
  });
});

// ============================================================================
// SCR-02 · Draft-identity guarded async audio/subtitle callbacks, live-state
//          clip allocation, and copy-on-write / ref-counted subtitles
// ============================================================================

describe("SCR-02 · draft-bound audio/subtitle callbacks and copy-on-write subtitles", () => {
  function createTwoMoveDraft(title: string): ScribeDraft {
    const base = createBlankDraft(title);
    let games = parsePgnGames(base.pgnText);
    const m1 = playMoveAtNode(games, "g0", { from: "e2", to: "e4" })!;
    games = m1.games;
    const m2 = playMoveAtNode(games, "g0/0", { from: "e7", to: "e5" })!;
    games = m2.games;
    return {
      ...base,
      pgnText: serializePgnGames(games),
    };
  }

  it("ignores late audio and subtitle callbacks targeting draft A after switching to draft B", () => {
    const draftA = createTwoMoveDraft("Draft A");
    const draftB = createTwoMoveDraft("Draft B");

    const lateAudio = applyAudioClipAttachment(draftB, {
      targetDraftId: draftA.id,
      nodeId: "g0/0",
      requestedClipId: null,
      clipTemplate: {
        mimeType: "audio/ogg",
        extension: "ogg",
        durationMs: 1500,
        label: "Late recording from A",
      },
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(lateAudio).toBeNull();

    // Add a clip to draft B so clipId exists, then fire a stale subtitle update for draft A
    const attachedOnB = applyAudioClipAttachment(draftB, {
      targetDraftId: draftB.id,
      nodeId: "g0/0",
      requestedClipId: null,
      clipTemplate: {
        mimeType: "audio/ogg",
        extension: "ogg",
        durationMs: 1200,
      },
      bytes: new Uint8Array([9, 9]),
    })!;

    const lateSub = applySubtitleUpdate(attachedOnB.draft, {
      targetDraftId: draftA.id,
      clipId: attachedOnB.clipId,
      lang: "en",
      vttText: "WEBVTT\n\n00:00.000 --> 00:01.000\nWrong draft!",
    });
    expect(lateSub).toBeNull();
    expect(Object.keys(attachedOnB.draft.subtitlesByPath)).toHaveLength(0);
  });

  it("allocates distinct clip IDs on concurrent attachments and preserves intervening PGN edits", () => {
    const initial = createTwoMoveDraft("Concurrent Audio");
    const bytes1 = new Uint8Array([10, 20, 30]);
    const bytes2 = new Uint8Array([40, 50, 60, 70]);

    // First attachment arrives for g0/0
    const res1 = applyAudioClipAttachment(initial, {
      targetDraftId: initial.id,
      nodeId: "g0/0",
      requestedClipId: null,
      clipTemplate: { mimeType: "audio/ogg", extension: "ogg", durationMs: 1400 },
      bytes: bytes1,
    })!;
    expect(res1.clipId).toBe("clip-001");

    // Intervening user prose edit on g0/0 before second attachment arrives
    const gamesAfterEdit = updateNodeTags(parsePgnGames(res1.draft.pgnText), "g0/0", (tags) => ({
      ...tags,
      prose: "Intervening coach comment must survive!",
    }));
    const afterProseEdit: ScribeDraft = {
      ...res1.draft,
      pgnText: serializePgnGames(gamesAfterEdit),
    };

    // Second concurrent attachment arrives for g0/0.0 (started when manifest.clips was empty)
    const res2 = applyAudioClipAttachment(afterProseEdit, {
      targetDraftId: initial.id,
      nodeId: "g0/0.0",
      requestedClipId: null,
      clipTemplate: { mimeType: "audio/webm", extension: "webm", durationMs: 2100 },
      bytes: bytes2,
    })!;

    expect(res2.clipId).toBe("clip-002");
    expect(Object.keys(res2.draft.manifest.clips).sort()).toEqual(["clip-001", "clip-002"]);
    expect(res2.draft.audioByPath["audio/clip-001.ogg"]).toEqual(bytes1);
    expect(res2.draft.audioByPath["audio/clip-002.webm"]).toEqual(bytes2);
    expect(res2.draft.pgnText).toContain("Intervening coach comment must survive!");
    expect(res2.draft.pgnText).toContain("[%audio clip-001]");
    expect(res2.draft.pgnText).toContain("[%audio clip-002]");
  });

  it("uses copy-on-write when editing a shared subtitle path and ref-counts on clear", () => {
    const sharedPath = "subtitles/en/shared.vtt";
    const originalVtt = "WEBVTT\n\n00:00.000 --> 00:01.000\nShared caption";
    const base = createTwoMoveDraft("Shared Subtitles");
    const clip1: ClipDefinition = {
      id: "clip-001",
      path: "audio/clip-001.ogg",
      mimeType: "audio/ogg",
      durationMs: 1500,
      subtitles: { en: sharedPath },
    };
    const clip2: ClipDefinition = {
      id: "clip-002",
      path: "audio/clip-002.ogg",
      mimeType: "audio/ogg",
      durationMs: 1500,
      subtitles: { en: sharedPath },
    };
    const draftWithShared: ScribeDraft = {
      ...base,
      manifest: {
        ...base.manifest,
        clips: { "clip-001": clip1, "clip-002": clip2 },
      },
      subtitlesByPath: { [sharedPath]: originalVtt },
    };

    // 1. Editing clip-001's shared subtitle copies on write without mutating clip-002
    const editedVtt = "WEBVTT\n\n00:00.000 --> 00:01.000\nClip 1 custom caption";
    const afterEdit = applySubtitleUpdate(draftWithShared, {
      targetDraftId: draftWithShared.id,
      clipId: "clip-001",
      lang: "en",
      vttText: editedVtt,
    })!;

    const clip1NewPath = afterEdit.manifest.clips["clip-001"]?.subtitles?.["en"];
    expect(clip1NewPath).toBe("subtitles/en/clip-001.vtt");
    expect(afterEdit.subtitlesByPath[clip1NewPath!]).toBe(editedVtt);
    expect(afterEdit.manifest.clips["clip-002"]?.subtitles?.["en"]).toBe(sharedPath);
    expect(afterEdit.subtitlesByPath[sharedPath]).toBe(originalVtt);

    // 2. Clearing clip-001 on the original shared draft leaves sharedPath intact for clip-002
    const afterClearFirst = applySubtitleUpdate(draftWithShared, {
      targetDraftId: draftWithShared.id,
      clipId: "clip-001",
      lang: "en",
      vttText: "   ",
    })!;
    expect(afterClearFirst.manifest.clips["clip-001"]?.subtitles).toBeUndefined();
    expect(afterClearFirst.manifest.clips["clip-002"]?.subtitles?.["en"]).toBe(sharedPath);
    expect(afterClearFirst.subtitlesByPath[sharedPath]).toBe(originalVtt);

    // 3. Clearing clip-002 as well removes the now-unreferenced shared file
    const afterClearBoth = applySubtitleUpdate(afterClearFirst, {
      targetDraftId: draftWithShared.id,
      clipId: "clip-002",
      lang: "en",
      vttText: "",
    })!;
    expect(afterClearBoth.manifest.clips["clip-002"]?.subtitles).toBeUndefined();
    expect(afterClearBoth.subtitlesByPath[sharedPath]).toBeUndefined();
  });
});

// ============================================================================
// SCR-03 · Mic acquisition guard, unmount/draft-switch abort, and interruption
// ============================================================================

describe("SCR-03 · microphone acquisition guard, abort cleanup, and interruption UI", () => {
  function createHarness(initialDraftId = "draft-A") {
    const state = {
      mounted: true,
      draftId: initialDraftId,
      isAcquiring: false,
      abortController: null as AbortController | null,
      recorder: null as ActiveRecordingSession | null,
      target: null as MicRecordingTarget | null,
      timer: null as ReturnType<typeof setInterval> | null,
      isRecording: false,
      recordingNodeId: null as NodeId | null,
      recordMs: 0,
      micLevel: 0,
      audioError: null as string | null,
      attachedClips: [] as Array<{ targetDraftId: string; nodeId: NodeId; bytes: Uint8Array }>,
    };

    const adapter: MicRecordingStateAdapter = {
      isMounted: () => state.mounted,
      getDraftId: () => state.draftId,
      getIsAcquiring: () => state.isAcquiring,
      setIsAcquiring: (v) => {
        state.isAcquiring = v;
      },
      getAbortController: () => state.abortController,
      setAbortController: (c) => {
        state.abortController = c;
      },
      getRecorder: () => state.recorder,
      setRecorder: (s) => {
        state.recorder = s;
      },
      getTarget: () => state.target,
      setTarget: (t) => {
        state.target = t;
      },
      getTimer: () => state.timer,
      setTimer: (t) => {
        state.timer = t;
      },
      setIsRecording: (v) => {
        state.isRecording = v;
      },
      setRecordingNodeId: (id) => {
        state.recordingNodeId = id;
      },
      setRecordMs: (ms) => {
        state.recordMs = ms;
      },
      setMicLevel: (lvl) => {
        state.micLevel = lvl;
      },
      setAudioError: (err) => {
        state.audioError = err;
      },
      stopAudition: () => undefined,
      onAttachAudioClip: (params) => {
        state.attachedClips.push({
          targetDraftId: params.targetDraftId,
          nodeId: params.nodeId,
          bytes: params.bytes,
        });
      },
      startMic: startMicRecording,
    };

    return { state, adapter };
  }

  function installFakeMediaApis(options: {
    getUserMedia: () => Promise<MediaStream>;
    onRecorderCreated?: (rec: FakeMediaRecorder) => void;
  }) {
    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      state: "inactive" | "recording" = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((ev: { data: Blob }) => void) | null = null;
      onerror: (() => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(
        public stream: MediaStream,
        _opts?: { mimeType?: string },
      ) {
        options.onRecorderCreated?.(this);
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }

    setGlobal("navigator", {
      mediaDevices: {
        getUserMedia: options.getUserMedia,
      },
    });
    setGlobal("MediaRecorder", FakeMediaRecorder);
    setGlobal("AudioContext", undefined);
    return FakeMediaRecorder;
  }

  type FakeMediaRecorder = {
    state: "inactive" | "recording";
    mimeType: string;
    ondataavailable: ((ev: { data: Blob }) => void) | null;
    onerror: (() => void) | null;
    onstop: (() => void) | null;
    start(): void;
    stop(): void;
  };

  it("blocks duplicate Record clicks while getUserMedia is pending and stops late-granted tracks on unmount", async () => {
    const permissionGrant = createDeferred<MediaStream>();
    const getUserMediaSpy = vi.fn(() => permissionGrant.promise);
    installFakeMediaApis({ getUserMedia: getUserMediaSpy });

    const track1Stop = vi.fn();
    const track2Stop = vi.fn();
    const fakeStream = {
      getTracks: () => [
        { kind: "audio", stop: track1Stop, addEventListener: vi.fn(), removeEventListener: vi.fn() },
        { kind: "audio", stop: track2Stop, addEventListener: vi.fn(), removeEventListener: vi.fn() },
      ],
      getAudioTracks: () => [
        { kind: "audio", stop: track1Stop, addEventListener: vi.fn(), removeEventListener: vi.fn() },
      ],
    } as unknown as MediaStream;

    const { state, adapter } = createHarness("draft-A");
    const target: MicRecordingTarget = {
      draftId: "draft-A",
      nodeId: "g0/0",
      san: "e4",
      attachedClipId: null,
    };

    // Double-click Record while getUserMedia is still pending
    const p1 = runStartMicRecording(adapter, target);
    expect(state.isAcquiring).toBe(true);
    const p2 = runStartMicRecording(adapter, target);
    await p2;
    expect(getUserMediaSpy).toHaveBeenCalledTimes(1);

    // Unmount & abort before permission resolves
    state.mounted = false;
    runCancelMicRecording(adapter, { resetUi: true });

    // Late permission grant resolves after unmount
    permissionGrant.resolve(fakeStream);
    await p1;

    expect(track1Stop).toHaveBeenCalledTimes(1);
    expect(track2Stop).toHaveBeenCalledTimes(1);
    expect(state.isAcquiring).toBe(false);
    expect(state.isRecording).toBe(false);
    expect(state.recorder).toBeNull();
    expect(state.timer).toBeNull();
    expect(state.attachedClips).toHaveLength(0);
  });

  it("surfaces a visible error and never commits partial audio on device error during capture", async () => {
    let createdRecorder: FakeMediaRecorder | null = null;
    const trackStop = vi.fn();
    const fakeStream = {
      getTracks: () => [
        { kind: "audio", stop: trackStop, addEventListener: vi.fn(), removeEventListener: vi.fn() },
      ],
      getAudioTracks: () => [
        { kind: "audio", stop: trackStop, addEventListener: vi.fn(), removeEventListener: vi.fn() },
      ],
    } as unknown as MediaStream;

    installFakeMediaApis({
      getUserMedia: async () => fakeStream,
      onRecorderCreated: (rec) => {
        createdRecorder = rec;
      },
    });

    const { state, adapter } = createHarness("draft-A");
    const target: MicRecordingTarget = {
      draftId: "draft-A",
      nodeId: "g0/0",
      san: "e4",
      attachedClipId: null,
    };

    await runStartMicRecording(adapter, target);
    expect(state.isRecording).toBe(true);
    expect(state.timer).not.toBeNull();
    expect(createdRecorder).not.toBeNull();

    // Emit partial chunk then fire hardware device error
    createdRecorder!.ondataavailable?.({
      data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" }),
    });
    createdRecorder!.onerror?.();

    expect(state.isRecording).toBe(false);
    expect(state.recordingNodeId).toBeNull();
    expect(state.recorder).toBeNull();
    expect(state.timer).toBeNull();
    expect(state.audioError).toMatch(/device error/i);
    expect(state.attachedClips).toHaveLength(0);
    expect(trackStop).toHaveBeenCalled();
  });

  it("discards audio if draft changes while recording stop() is finalizing", async () => {
    const stopGate = createDeferred<{
      bytes: Uint8Array;
      mimeType: string;
      extension: string;
      durationMs: number;
      peaks: number[];
    }>();

    const { state, adapter } = createHarness("draft-A");
    state.recorder = {
      isActive: () => true,
      getLevel: () => 0.4,
      cancel: vi.fn(),
      stop: () => stopGate.promise,
    };
    state.target = {
      draftId: "draft-A",
      nodeId: "g0/0",
      san: "e4",
      attachedClipId: null,
    };
    state.isRecording = true;

    const stopPromise = runStopMicRecording(adapter, state.target);
    // Switch draft while stop() is still decoding audio
    state.draftId = "draft-B";

    stopGate.resolve({
      bytes: new Uint8Array([9, 8, 7]),
      mimeType: "audio/webm",
      extension: "webm",
      durationMs: 1200,
      peaks: [0.5],
    });
    await stopPromise;

    expect(state.attachedClips).toHaveLength(0);
  });
});

// ============================================================================
// SCR-04 · Dirty raw PGN buffer conflict preservation, silent .pgna omitted
//          clips normalization, and strict audio import duration
// ============================================================================

describe("SCR-04 · raw PGN buffer preservation, silent .pgna normalization, and strict audio decode", () => {
  it("preserves user raw PGN edits when external pgnText changes and flags conflict until resolved", () => {
    const basePgn = '[Event "Study"]\n[Result "*"]\n\n1. e4 *';
    let buffer = createRawPgnBuffer("draft-1", basePgn);

    // Clean initially
    expect(deriveRawPgnView(buffer, "draft-1", basePgn)).toEqual({
      displayedPgn: basePgn,
      isDirty: false,
      hasConflict: false,
    });

    // User edits raw PGN
    const userDraftPgn = '[Event "Study"]\n[Result "*"]\n\n1. e4 { My raw edit } *';
    buffer = editRawPgnBuffer(buffer, "draft-1", basePgn, userDraftPgn);
    expect(deriveRawPgnView(buffer, "draft-1", basePgn)).toEqual({
      displayedPgn: userDraftPgn,
      isDirty: true,
      hasConflict: false,
    });

    // Another control modifies the study PGN externally (e.g., board move)
    const externallyUpdatedPgn = '[Event "Study"]\n[Result "*"]\n\n1. e4 e5 *';
    const conflictView = deriveRawPgnView(buffer, "draft-1", externallyUpdatedPgn);
    expect(conflictView).toEqual({
      displayedPgn: userDraftPgn,
      isDirty: true,
      hasConflict: true,
    });

    // Further typing while conflicted keeps the conflict flag true (does not silently rebase!)
    const userDraftPgn2 = `${userDraftPgn}\n`;
    buffer = editRawPgnBuffer(buffer, "draft-1", externallyUpdatedPgn, userDraftPgn2);
    expect(deriveRawPgnView(buffer, "draft-1", externallyUpdatedPgn)).toEqual({
      displayedPgn: userDraftPgn2,
      isDirty: true,
      hasConflict: true,
    });

    // Switching to another draft resets view cleanly to the new draft's PGN
    const otherDraftPgn = '[Event "Other"]\n[Result "*"]\n\n1. d4 *';
    expect(deriveRawPgnView(buffer, "draft-2", otherDraftPgn)).toEqual({
      displayedPgn: otherDraftPgn,
      isDirty: false,
      hasConflict: false,
    });
  });

  it("normalizes an imported silent .pgna with omitted manifest.clips so draftStore and listLocalDrafts succeed", async () => {
    const pgnText = '[Event "Silent Study"]\n[Result "*"]\n\n1. e4 { [%at #1] } *';
    const compiled = compilePgna({
      manifest: {
        format: "pgna",
        version: PGNA_FORMAT_VERSION,
        pgnPath: "study.pgn",
        timelinePath: "timeline.json",
        title: "Silent Study",
        clips: {},
      },
      pgnText,
    });

    // Manually construct a silent PGNA v1.0 ZIP whose manifest.json omits `clips`
    const manifestWithoutClips = {
      format: "pgna",
      version: PGNA_FORMAT_VERSION,
      pgnPath: "study.pgn",
      timelinePath: "timeline.json",
      title: "Silent Study Without Clips Key",
    };

    const entries = prepareArchiveEntries([
      { path: "manifest.json", data: utf8Encode(JSON.stringify(manifestWithoutClips, null, 2)) },
      { path: "study.pgn", data: utf8Encode(pgnText) },
      { path: "timeline.json", data: utf8Encode(JSON.stringify(compiled.timeline, null, 2)) },
    ]);
    const zipBytes = await packPgnaZip(entries);

    const unpacked = await unpackPgnaArchive(zipBytes);
    const importedDraft = buildImportedPgnaDraft(unpacked, "silent-import-draft");

    expect(importedDraft.manifest.clips).toEqual({});
    await saveLocalDraft(importedDraft);

    const summaries = await listLocalDrafts();
    const found = summaries.find((s) => s.id === "silent-import-draft");
    expect(found).toBeDefined();
    expect(found?.title).toBe("Silent Study Without Clips Key");
    expect(found?.clipCount).toBe(0);
  });

  it("rejects undecodable audio bytes under strictDuration instead of fabricating a 3-second clip", async () => {
    class FailingAudioContext {
      decodeAudioData() {
        return Promise.reject(new Error("EncodingError: unable to decode audio data"));
      }
      close() {
        return Promise.resolve();
      }
    }
    setGlobal("AudioContext", FailingAudioContext);
    setGlobal("Audio", undefined);

    const corruptBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await expect(
      decodeAudioMetadata(corruptBytes, undefined, 64, {
        strictDuration: true,
        mimeType: "audio/ogg",
      }),
    ).rejects.toThrow(/decode audio duration/i);
  });
});

// ============================================================================
// FMT-02 · Scribe export gate contingent on final archive validity
// ============================================================================

describe("FMT-02 · export gate rejects missing media and round-trips valid narrated archives", () => {
  function createNarratedDraft(options?: { omitAudioBytes?: boolean }): {
    draft: ScribeDraft;
    audioBytes: Uint8Array;
    vttText: string;
  } {
    const base = createBlankDraft("Narrated Sicilian");
    const m1 = playMoveAtNode(parsePgnGames(base.pgnText), "g0", { from: "e2", to: "e4" })!;
    const draftWithMove: ScribeDraft = {
      ...base,
      pgnText: serializePgnGames(m1.games),
    };

    const audioBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0xaa, 0xbb]);
    const attached = applyAudioClipAttachment(draftWithMove, {
      targetDraftId: draftWithMove.id,
      nodeId: "g0/0",
      requestedClipId: null,
      clipTemplate: {
        mimeType: "audio/ogg",
        extension: "ogg",
        durationMs: 2400,
        label: "1. e4 narration",
      },
      bytes: audioBytes,
    })!;

    const vttText = "WEBVTT\n\n00:00.000 --> 00:02.400\nControl the center with 1. e4.";
    const withSub = applySubtitleUpdate(attached.draft, {
      targetDraftId: attached.draft.id,
      clipId: attached.clipId,
      lang: "en",
      vttText,
    })!;

    if (options?.omitAudioBytes) {
      return {
        draft: {
          ...withSub,
          audioByPath: {},
        },
        audioBytes,
        vttText,
      };
    }

    return { draft: withSub, audioBytes, vttText };
  }

  it("throws PgnaPackError(MISSING_MEDIA) and never produces a successful export when audio bytes are missing", async () => {
    const { draft } = createNarratedDraft({ omitAudioBytes: true });

    // Even when PGN compiler diagnostics have 0 errors, archive export MUST fail!
    const compiled = compilePgna({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
      subtitlesByPath: draft.subtitlesByPath,
    });
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);

    let caught: unknown = null;
    try {
      await buildValidatedPgnaArchive(draft);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PgnaPackError);
    expect((caught as PgnaPackError).code).toBe("MISSING_MEDIA");
    expect(formatPgnaExportError(caught)).toContain("MISSING_MEDIA");
  });

  it("exports, validates, and reopens a valid narrated draft with exact audio bytes and subtitle text", async () => {
    const { draft, audioBytes, vttText } = createNarratedDraft();

    const zipBytes = await buildValidatedPgnaArchive(draft);
    const validation = await validatePgnaZip(zipBytes);
    expect(validation.valid).toBe(true);

    const unpacked = await unpackPgnaArchive(zipBytes);
    const reopened = buildImportedPgnaDraft(unpacked, "reopened-narrated");

    expect(reopened.manifest.clips["clip-001"]?.path).toBe("audio/clip-001.ogg");
    expect(reopened.audioByPath["audio/clip-001.ogg"]).toEqual(audioBytes);
    expect(reopened.manifest.clips["clip-001"]?.subtitles?.["en"]).toBe("subtitles/en/clip-001.vtt");
    expect(reopened.subtitlesByPath["subtitles/en/clip-001.vtt"]).toBe(vttText);
    // Generated merged timeline.vtt must be stripped on reopen so re-export never collides
    expect(reopened.subtitlesByPath["subtitles/en/timeline.vtt"]).toBeUndefined();
  });
});

// ============================================================================
// SCR-05 · Persistent publish state outside dismissible dialog, idempotency,
//          non-truncating batched tags, and strict title/description bounds
// ============================================================================

describe("SCR-05 · persistent publish state, single in-flight guard, and strict metadata bounds", () => {
  const coachSession = {
    sub: "00000000-0000-4000-8000-000000000001",
    handle: "coach-alice",
    role: "coach" as const,
    programIds: [] as string[],
    iat: 1_700_000_000,
    exp: 1_900_000_000,
  };

  it("produces one study and one retrievable result when closing and reopening while publishing", async () => {
    const draft = createDemoItalianDraft();
    const zipBytes = await buildValidatedPgnaArchive(draft);
    const responseGate = createDeferred<Response>();

    let fetchCalls = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCalls++;
      return responseGate.promise;
    };

    const controller = createPublishSessionController({
      createKey: () => "scr05-idem-key-1",
    });

    const p1 = controller.startPublish({
      draftId: draft.id,
      kibitzApiBaseUrl: "http://localhost:4002",
      session: coachSession,
      tags: ["openings"],
      title: draft.manifest.title,
      description: draft.manifest.description,
      manifest: draft.manifest,
      buildArchive: async () => zipBytes,
      fetchImpl: mockFetch,
    });

    // Simulate closing and reopening the dialog while still in flight
    controller.syncActiveDraft(draft.id);
    expect(controller.getState().status).toBe("publishing");

    // Re-attempting submit after reopen returns the existing in-flight promise (no 2nd fetch)
    const p2 = controller.startPublish({
      draftId: draft.id,
      kibitzApiBaseUrl: "http://localhost:4002",
      session: coachSession,
      tags: ["openings"],
      title: draft.manifest.title,
      description: draft.manifest.description,
      manifest: draft.manifest,
      buildArchive: async () => zipBytes,
      fetchImpl: mockFetch,
    });
    expect(p2).toBe(p1);

    // Resolve while dialog is closed; result remains retrievable upon reopen
    responseGate.resolve(
      new Response(
        JSON.stringify({
          studyId: "study-scr05-1",
          study: { id: "study-scr05-1", ownerHandle: "coach-alice", tags: ["openings"] },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await p1;
    expect(fetchCalls).toBe(1);
    expect(result.published).toBe(true);
    expect(result.studyId).toBe("study-scr05-1");
    expect(controller.getState().status).toBe("succeeded");
    expect(controller.getState().result).toEqual(result);
  });

  it("round-trips boundary-length metadata unchanged and rejects overflow before archive build or fetch", async () => {
    const draft = createDemoItalianDraft();
    const exactTitle = "A".repeat(MAX_PUBLISH_TITLE_LENGTH);
    const exactDescription = "B".repeat(MAX_PUBLISH_DESCRIPTION_LENGTH);
    const exactTags = Array.from({ length: MAX_PUBLISH_TAGS }, (_, i) => `t${i + 1}`);

    expect(
      validatePublishMetadata({
        title: exactTitle,
        description: exactDescription,
        tags: exactTags,
      }),
    ).toEqual({
      ok: true,
      title: exactTitle,
      description: exactDescription,
      tags: exactTags,
    });

    // Batched comma-separated paste crossing 12 tags surfaces overflow instead of truncating
    const batched = mergePendingTagInput(exactTags.slice(0, 10), "t11, t12, t13");
    expect(batched.overflow).toEqual(["t13"]);

    const buildSpy = vi.fn(async () => buildValidatedPgnaArchive(draft));
    const fetchSpy = vi.fn<typeof fetch>();
    const controller = createPublishSessionController();

    const overTitleRes = await controller.startPublish({
      draftId: draft.id,
      kibitzApiBaseUrl: "http://localhost:4002",
      session: coachSession,
      title: "A".repeat(MAX_PUBLISH_TITLE_LENGTH + 1),
      description: exactDescription,
      tags: exactTags,
      manifest: draft.manifest,
      buildArchive: buildSpy,
      fetchImpl: fetchSpy,
    });
    expect(overTitleRes.published).toBe(false);
    expect(overTitleRes.message).toContain(`${MAX_PUBLISH_TITLE_LENGTH}`);

    const overDescRes = await controller.startPublish({
      draftId: draft.id,
      kibitzApiBaseUrl: "http://localhost:4002",
      session: coachSession,
      title: exactTitle,
      description: "B".repeat(MAX_PUBLISH_DESCRIPTION_LENGTH + 1),
      tags: exactTags,
      manifest: draft.manifest,
      buildArchive: buildSpy,
      fetchImpl: fetchSpy,
    });
    expect(overDescRes.published).toBe(false);
    expect(overDescRes.message).toContain(`${MAX_PUBLISH_DESCRIPTION_LENGTH}`);

    const overTagsRes = await controller.startPublish({
      draftId: draft.id,
      kibitzApiBaseUrl: "http://localhost:4002",
      session: coachSession,
      title: exactTitle,
      description: exactDescription,
      tags: [...exactTags, "t13"],
      manifest: draft.manifest,
      buildArchive: buildSpy,
      fetchImpl: fetchSpy,
    });
    expect(overTagsRes.published).toBe(false);
    expect(overTagsRes.message).toContain(`${MAX_PUBLISH_TAGS}`);

    expect(buildSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
