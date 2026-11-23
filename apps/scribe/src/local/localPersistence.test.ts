import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeAudioMetadata,
  probeHtmlAudioDurationMs,
  startMicRecording,
} from "./audioStudio";
import {
  clearMemoryDraftFallbackForTests,
  getDraftStorageMode,
  listLocalDrafts,
  loadLocalDraft,
  saveLocalDraft,
} from "./draftStore";
import {
  createBlankDraft,
  normalizeScribeDraft,
  type ScribeDraft,
} from "./draftWorkspace";

type GlobalRecord = Record<string, unknown>;

function setGlobal(key: string, value: unknown): () => void {
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
  return () => {
    if (hadOwn && previousDescriptor) {
      Object.defineProperty(g, key, previousDescriptor);
    } else {
      delete g[key];
    }
  };
}

function createFakeIndexedDb(initialRecords: unknown[] = [], options?: { failPut?: boolean }) {
  const store = new Map<string, unknown>();
  let untitledCounter = 0;
  for (const record of initialRecords) {
    const key =
      typeof record === "object" &&
      record !== null &&
      "id" in record &&
      typeof (record as { id?: unknown }).id === "string"
        ? (record as { id: string }).id
        : `__corrupt_${++untitledCounter}`;
    store.set(key, record);
  }

  const fakeIdb = {
    open(_name: string, _version: number) {
      const openReq: Record<string, unknown> = {
        result: null,
        error: null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };

      const db = {
        objectStoreNames: {
          contains: () => true,
        },
        createObjectStore: () => ({}),
        close: () => {},
        transaction(_storeName: string, _mode: string) {
          const tx: Record<string, unknown> = {
            error: null,
            oncomplete: null as (() => void) | null,
            onerror: null as (() => void) | null,
            onabort: null as (() => void) | null,
            objectStore() {
              return {
                put(value: { id: string }) {
                  queueMicrotask(() => {
                    if (options?.failPut) {
                      tx["error"] = new Error("Quota exceeded");
                      (tx["onerror"] as (() => void) | null)?.();
                      return;
                    }
                    store.set(value.id, value);
                    (tx["oncomplete"] as (() => void) | null)?.();
                  });
                  return {};
                },
                get(id: string) {
                  const req: Record<string, unknown> = {
                    result: undefined,
                    error: null,
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null,
                  };
                  queueMicrotask(() => {
                    req["result"] = store.get(id);
                    (req["onsuccess"] as (() => void) | null)?.();
                  });
                  return req;
                },
                getAll() {
                  const req: Record<string, unknown> = {
                    result: [] as unknown[],
                    error: null,
                    onsuccess: null as (() => void) | null,
                    onerror: null as (() => void) | null,
                  };
                  queueMicrotask(() => {
                    req["result"] = [...store.values()];
                    (req["onsuccess"] as (() => void) | null)?.();
                  });
                  return req;
                },
                delete(id: string) {
                  queueMicrotask(() => {
                    store.delete(id);
                    (tx["oncomplete"] as (() => void) | null)?.();
                  });
                  return {};
                },
              };
            },
          };
          return tx;
        },
      };

      queueMicrotask(() => {
        openReq["result"] = db;
        (openReq["onsuccess"] as (() => void) | null)?.();
      });

      return openReq;
    },
  };

  return { fakeIdb, store };
}

class FakeTrack {
  readonly kind = "audio";
  stopped = false;
  private listeners = new Map<string, Set<() => void>>();

  stop() {
    this.stopped = true;
  }

  addEventListener(event: string, cb: () => void) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
  }

  removeEventListener(event: string, cb: () => void) {
    this.listeners.get(event)?.delete(cb);
  }

  emit(event: string) {
    for (const cb of [...(this.listeners.get(event) ?? [])]) {
      cb();
    }
  }
}

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  static lastInstance: FakeMediaRecorder | null = null;

  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;

  constructor(_stream: MediaStream, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "audio/webm";
    FakeMediaRecorder.lastInstance = this;
  }

  start(_timeslice?: number) {
    this.state = "recording";
  }

  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.onstop?.();
  }

  emitChunk(bytes: Uint8Array) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    this.ondataavailable?.({ data: new Blob([copy], { type: this.mimeType }) });
  }

  emitError() {
    this.onerror?.(new Event("error"));
  }

  emitUnexpectedStop() {
    this.state = "inactive";
    this.onstop?.();
  }
}

describe("Scribe local persistence, normalization, audio metadata, and mic lifecycle", () => {
  const restorers: Array<() => void> = [];

  afterEach(() => {
    clearMemoryDraftFallbackForTests();
    FakeMediaRecorder.lastInstance = null;
    while (restorers.length > 0) {
      restorers.pop()?.();
    }
    vi.restoreAllMocks();
  });

  describe("draft normalization & draftStore durability (SCR-01, SCR-04)", () => {
    it("normalizes legacy drafts with omitted clips and rejects genuinely corrupt records", () => {
      expect(normalizeScribeDraft(null)).toBeNull();
      expect(normalizeScribeDraft("not-an-object")).toBeNull();
      expect(normalizeScribeDraft([])).toBeNull();
      expect(normalizeScribeDraft({ id: "", manifest: {}, pgnText: "*" })).toBeNull();
      expect(normalizeScribeDraft({ id: "   ", manifest: {}, pgnText: "*" })).toBeNull();
      expect(normalizeScribeDraft({ id: "d1", manifest: null, pgnText: "*" })).toBeNull();
      expect(normalizeScribeDraft({ id: "d1", manifest: {}, pgnText: 42 })).toBeNull();

      const legacySilent = normalizeScribeDraft({
        id: "legacy-silent-01",
        manifest: {
          title: "Silent Endgame Study",
          author: "Coach",
        },
        pgnText: "1. e4 e5 *",
      });

      expect(legacySilent).not.toBeNull();
      expect(legacySilent?.id).toBe("legacy-silent-01");
      expect(legacySilent?.manifest.format).toBe("pgna");
      expect(legacySilent?.manifest.version).toBe("1.0");
      expect(legacySilent?.manifest.pgnPath).toBe("study.pgn");
      expect(legacySilent?.manifest.timelinePath).toBe("timeline.json");
      expect(legacySilent?.manifest.clips).toEqual({});
      expect(legacySilent?.audioByPath).toEqual({});
      expect(legacySilent?.subtitlesByPath).toEqual({});
      expect(typeof legacySilent?.updatedAt).toBe("string");
      expect((legacySilent?.updatedAt ?? "").length).toBeGreaterThan(0);
    });

    it("reports memory persistence mode when IndexedDB is unavailable", async () => {
      restorers.push(setGlobal("indexedDB", undefined));

      expect(getDraftStorageMode()).toBe("memory");
      const draft = createBlankDraft("Memory Draft");
      const result = await saveLocalDraft(draft);

      expect(result.mode).toBe("memory");
      expect(typeof result.updatedAt).toBe("string");

      const loaded = await loadLocalDraft(draft.id);
      expect(loaded?.manifest.title).toBe("Memory Draft");
      expect(loaded?.manifest.clips).toEqual({});
    });

    it("reports indexeddb mode when IndexedDB is available and rejects on write failure", async () => {
      const { fakeIdb } = createFakeIndexedDb();
      restorers.push(setGlobal("indexedDB", fakeIdb));

      expect(getDraftStorageMode()).toBe("indexeddb");
      const draft = createBlankDraft("Durable Study");
      const saved = await saveLocalDraft(draft);
      expect(saved.mode).toBe("indexeddb");

      const loaded = await loadLocalDraft(draft.id);
      expect(loaded?.id).toBe(draft.id);
      expect(loaded?.manifest.title).toBe("Durable Study");

      // Failure must reject instead of silently pretending it saved
      const { fakeIdb: failingIdb } = createFakeIndexedDb([], { failPut: true });
      restorers.push(setGlobal("indexedDB", failingIdb));
      await expect(saveLocalDraft(draft)).rejects.toThrow("Quota exceeded");
    });

    it("lists valid and legacy silent drafts while isolating corrupt records in IndexedDB", async () => {
      const validWithClip = createBlankDraft("Narrated Opening");
      validWithClip.updatedAt = "2026-11-23T10:00:00.000Z";
      validWithClip.manifest.clips["clip-001"] = {
        id: "clip-001",
        path: "audio/clip-001.ogg",
        mimeType: "audio/ogg",
        durationMs: 2400,
      };

      // Legacy PGNA v1.0 draft where `clips` was omitted entirely
      const legacySilentRecord = {
        id: "silent-pgna-draft",
        manifest: {
          format: "pgna",
          version: "1.0",
          pgnPath: "study.pgn",
          timelinePath: "timeline.json",
          title: "Silent Legacy Draft",
        },
        pgnText: "1. d4 d5 *",
        audioByPath: {},
        subtitlesByPath: {},
        updatedAt: "2026-11-23T11:00:00.000Z",
      };

      // Corrupt records that must be isolated without hiding valid drafts
      const corruptMissingManifest = { id: "corrupt-1", pgnText: "1. e4 *" };
      const corruptMissingPgn = { id: "corrupt-2", manifest: { title: "Broken" } };
      const corruptPrimitive = "bad-entry";

      const { fakeIdb } = createFakeIndexedDb([
        validWithClip,
        legacySilentRecord,
        corruptMissingManifest,
        corruptMissingPgn,
        corruptPrimitive,
      ]);
      restorers.push(setGlobal("indexedDB", fakeIdb));

      const summaries = await listLocalDrafts();
      expect(summaries).toHaveLength(2);
      expect(summaries[0]).toEqual({
        id: "silent-pgna-draft",
        title: "Silent Legacy Draft",
        updatedAt: "2026-11-23T11:00:00.000Z",
        clipCount: 0,
      });
      expect(summaries[1]).toEqual({
        id: validWithClip.id,
        title: "Narrated Opening",
        updatedAt: "2026-11-23T10:00:00.000Z",
        clipCount: 1,
      });

      const loadedLegacy = await loadLocalDraft("silent-pgna-draft");
      expect(loadedLegacy).not.toBeNull();
      expect(loadedLegacy?.manifest.clips).toEqual({});

      const loadedCorrupt = await loadLocalDraft("corrupt-1");
      expect(loadedCorrupt).toBeNull();
    });

    it("normalizes legacy drafts when saving via saveLocalDraft", async () => {
      restorers.push(setGlobal("indexedDB", undefined));
      const legacy = {
        id: "save-legacy",
        manifest: {
          title: "Missing Clips",
        },
        pgnText: "*",
      } as unknown as ScribeDraft;

      const res = await saveLocalDraft(legacy);
      expect(res.mode).toBe("memory");
      const loaded = await loadLocalDraft("save-legacy");
      expect(loaded?.manifest.clips).toEqual({});
      expect(loaded?.manifest.format).toBe("pgna");
    });
  });

  describe("audio metadata decoding & strict duration (SCR-04)", () => {
    it("throws in strictDuration mode when both Web Audio and HTML <audio> decoding fail", async () => {
      restorers.push(setGlobal("AudioContext", undefined));
      restorers.push(setGlobal("Audio", undefined));

      const bytes = new Uint8Array([0, 1, 2, 3]);
      await expect(
        decodeAudioMetadata(bytes, 3000, 32, { strictDuration: true, mimeType: "audio/ogg" }),
      ).rejects.toThrow(
        "Could not decode audio duration. The file may be corrupted or in an unsupported audio format.",
      );

      // Non-strict mode still falls back to caller's authoritative fallback duration
      const nonStrict = await decodeAudioMetadata(bytes, 3000, 16);
      expect(nonStrict.durationSource).toBe("fallback");
      expect(nonStrict.durationMs).toBe(3000);
      expect(nonStrict.peaks).toHaveLength(16);
    });

    it("uses HTML <audio> loadedmetadata fallback when Web Audio is unavailable and revokes object URL", async () => {
      restorers.push(setGlobal("AudioContext", undefined));

      const revoked: string[] = [];
      const origCreateObjectURL = URL.createObjectURL;
      const origRevokeObjectURL = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn(() => "blob:fake-audio-1");
      URL.revokeObjectURL = vi.fn((url: string) => {
        revoked.push(url);
      });
      restorers.push(() => {
        URL.createObjectURL = origCreateObjectURL;
        URL.revokeObjectURL = origRevokeObjectURL;
      });

      class FakeHtmlAudio {
        preload = "";
        duration = 4.321;
        private listeners = new Map<string, Set<() => void>>();
        private _src = "";

        addEventListener(event: string, cb: () => void) {
          let set = this.listeners.get(event);
          if (!set) {
            set = new Set();
            this.listeners.set(event, set);
          }
          set.add(cb);
        }

        removeEventListener(event: string, cb: () => void) {
          this.listeners.get(event)?.delete(cb);
        }

        set src(value: string) {
          this._src = value;
          if (value) {
            queueMicrotask(() => {
              for (const cb of [...(this.listeners.get("loadedmetadata") ?? [])]) {
                cb();
              }
            });
          }
        }

        get src() {
          return this._src;
        }

        load() {}
      }

      restorers.push(setGlobal("Audio", FakeHtmlAudio));

      const meta = await decodeAudioMetadata(new Uint8Array([10, 20, 30]), 3000, 24, {
        strictDuration: true,
        mimeType: "audio/mpeg",
      });

      expect(meta.durationSource).toBe("html-audio");
      expect(meta.durationMs).toBe(4321);
      expect(meta.peaks).toHaveLength(24);
      expect(revoked).toEqual(["blob:fake-audio-1"]);
    });

    it("rejects NaN, Infinity, and non-positive durations from HTML <audio> probe", async () => {
      restorers.push(setGlobal("AudioContext", undefined));

      const revoked: string[] = [];
      const origCreateObjectURL = URL.createObjectURL;
      const origRevokeObjectURL = URL.revokeObjectURL;
      let counter = 0;
      URL.createObjectURL = vi.fn(() => `blob:invalid-${++counter}`);
      URL.revokeObjectURL = vi.fn((url: string) => {
        revoked.push(url);
      });
      restorers.push(() => {
        URL.createObjectURL = origCreateObjectURL;
        URL.revokeObjectURL = origRevokeObjectURL;
      });

      for (const badDuration of [Number.NaN, Number.POSITIVE_INFINITY, 0, -2.5]) {
        class BadHtmlAudio {
          preload = "";
          duration = badDuration;
          private listeners = new Map<string, Set<() => void>>();

          addEventListener(event: string, cb: () => void) {
            let set = this.listeners.get(event);
            if (!set) {
              set = new Set();
              this.listeners.set(event, set);
            }
            set.add(cb);
          }

          removeEventListener(event: string, cb: () => void) {
            this.listeners.get(event)?.delete(cb);
          }

          set src(value: string) {
            if (value) {
              queueMicrotask(() => {
                for (const cb of [...(this.listeners.get("loadedmetadata") ?? [])]) {
                  cb();
                }
              });
            }
          }

          load() {}
        }

        const restoreAudio = setGlobal("Audio", BadHtmlAudio);
        try {
          const probed = await probeHtmlAudioDurationMs(new Uint8Array([1, 2, 3]), "audio/ogg");
          expect(probed).toBeNull();
        } finally {
          restoreAudio();
        }
      }

      expect(revoked).toHaveLength(4);
    });

    it("uses Web Audio API when available and returns durationSource webaudio", async () => {
      class FakeAudioContext {
        close() {
          return Promise.resolve();
        }
        decodeAudioData() {
          return Promise.resolve({
            duration: 2.75,
            getChannelData: () => new Float32Array([0.1, -0.8, 0.4, -0.2]),
          } as unknown as AudioBuffer);
        }
      }

      restorers.push(setGlobal("AudioContext", FakeAudioContext));

      const meta = await decodeAudioMetadata(new Uint8Array([5, 6, 7, 8]), 9999, 4, {
        strictDuration: true,
      });

      expect(meta.durationSource).toBe("webaudio");
      expect(meta.durationMs).toBe(2750);
      expect(meta.peaks).toHaveLength(4);
      expect(meta.peaks[1]).toBeCloseTo(0.8, 5);
    });
  });

  describe("microphone recording lifecycle & interruption handling (SCR-03)", () => {
    it("throws immediately without calling getUserMedia if AbortSignal is already aborted", async () => {
      const getUserMedia = vi.fn();
      restorers.push(
        setGlobal("navigator", {
          mediaDevices: { getUserMedia },
        }),
      );
      restorers.push(setGlobal("MediaRecorder", FakeMediaRecorder));

      const controller = new AbortController();
      controller.abort();

      await expect(startMicRecording({ signal: controller.signal })).rejects.toThrow(
        "Recording cancelled before microphone access.",
      );
      expect(getUserMedia).not.toHaveBeenCalled();
    });

    it("stops all granted tracks immediately when aborted while getUserMedia is pending", async () => {
      const track1 = new FakeTrack();
      const track2 = new FakeTrack();
      let resolveStream!: (stream: MediaStream) => void;
      const streamPromise = new Promise<MediaStream>((resolve) => {
        resolveStream = resolve;
      });

      const getUserMedia = vi.fn(() => streamPromise);
      restorers.push(
        setGlobal("navigator", {
          mediaDevices: { getUserMedia },
        }),
      );
      restorers.push(setGlobal("MediaRecorder", FakeMediaRecorder));

      const controller = new AbortController();
      const startPromise = startMicRecording({ signal: controller.signal });

      // Abort before permission resolves
      controller.abort();

      // Permission later resolves with live tracks
      resolveStream({
        getTracks: () => [track1, track2],
        getAudioTracks: () => [track1, track2],
      } as unknown as MediaStream);

      await expect(startPromise).rejects.toThrow("Recording cancelled before microphone access.");
      expect(track1.stopped).toBe(true);
      expect(track2.stopped).toBe(true);
      expect(FakeMediaRecorder.lastInstance).toBeNull();
    });

    it("handles recorder.onerror during active capture by interrupting, stopping tracks, and rejecting stop()", async () => {
      const track = new FakeTrack();
      const stream = {
        getTracks: () => [track],
        getAudioTracks: () => [track],
      } as unknown as MediaStream;

      restorers.push(
        setGlobal("navigator", {
          mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve(stream)) },
        }),
      );
      restorers.push(setGlobal("MediaRecorder", FakeMediaRecorder));
      restorers.push(setGlobal("AudioContext", undefined));

      const onInterrupted = vi.fn();
      const session = await startMicRecording({ onInterrupted });
      expect(session.isActive()).toBe(true);

      // Emit some partial data, then a device error
      FakeMediaRecorder.lastInstance?.emitChunk(new Uint8Array([1, 2, 3, 4]));
      FakeMediaRecorder.lastInstance?.emitError();

      expect(session.isActive()).toBe(false);
      expect(track.stopped).toBe(true);
      expect(onInterrupted).toHaveBeenCalledTimes(1);
      expect(onInterrupted).toHaveBeenCalledWith(
        "Microphone recording failed due to a device error.",
      );

      // Calling stop() must reject rather than committing partial audio
      await expect(session.stop()).rejects.toThrow(
        "Microphone recording failed due to a device error.",
      );
    });

    it("handles unexpected track ended event by interrupting, stopping tracks, and rejecting stop()", async () => {
      const track = new FakeTrack();
      const stream = {
        getTracks: () => [track],
        getAudioTracks: () => [track],
      } as unknown as MediaStream;

      restorers.push(
        setGlobal("navigator", {
          mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve(stream)) },
        }),
      );
      restorers.push(setGlobal("MediaRecorder", FakeMediaRecorder));
      restorers.push(setGlobal("AudioContext", undefined));

      const onInterrupted = vi.fn();
      const session = await startMicRecording({ onInterrupted });
      expect(session.isActive()).toBe(true);

      FakeMediaRecorder.lastInstance?.emitChunk(new Uint8Array([9, 8, 7]));
      track.emit("ended");

      expect(session.isActive()).toBe(false);
      expect(track.stopped).toBe(true);
      expect(onInterrupted).toHaveBeenCalledTimes(1);
      expect(onInterrupted).toHaveBeenCalledWith("Microphone stream ended unexpectedly.");

      await expect(session.stop()).rejects.toThrow("Microphone stream ended unexpectedly.");
    });

    it("treats unexpected recorder.onstop without user stop() as an interruption", async () => {
      const track = new FakeTrack();
      const stream = {
        getTracks: () => [track],
        getAudioTracks: () => [track],
      } as unknown as MediaStream;

      restorers.push(
        setGlobal("navigator", {
          mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve(stream)) },
        }),
      );
      restorers.push(setGlobal("MediaRecorder", FakeMediaRecorder));
      restorers.push(setGlobal("AudioContext", undefined));

      const onInterrupted = vi.fn();
      const session = await startMicRecording({ onInterrupted });
      FakeMediaRecorder.lastInstance?.emitChunk(new Uint8Array([4, 5, 6]));
      FakeMediaRecorder.lastInstance?.emitUnexpectedStop();

      expect(session.isActive()).toBe(false);
      expect(track.stopped).toBe(true);
      expect(onInterrupted).toHaveBeenCalledWith(
        "Recording stopped unexpectedly before completion.",
      );
      await expect(session.stop()).rejects.toThrow(
        "Recording stopped unexpectedly before completion.",
      );
    });

    it("completes normal start -> stop cleanly with bytes and stops all tracks", async () => {
      const track = new FakeTrack();
      const stream = {
        getTracks: () => [track],
        getAudioTracks: () => [track],
      } as unknown as MediaStream;

      restorers.push(
        setGlobal("navigator", {
          mediaDevices: { getUserMedia: vi.fn(() => Promise.resolve(stream)) },
        }),
      );
      restorers.push(setGlobal("MediaRecorder", FakeMediaRecorder));
      restorers.push(setGlobal("AudioContext", undefined));
      restorers.push(setGlobal("Audio", undefined));

      const onInterrupted = vi.fn();
      const session = await startMicRecording({ onInterrupted });
      expect(session.isActive()).toBe(true);

      const payload = new Uint8Array([11, 22, 33, 44, 55]);
      FakeMediaRecorder.lastInstance?.emitChunk(payload);

      const result = await session.stop();

      expect(session.isActive()).toBe(false);
      expect(track.stopped).toBe(true);
      expect(onInterrupted).not.toHaveBeenCalled();
      expect(Array.from(result.bytes)).toEqual([11, 22, 33, 44, 55]);
      expect(result.durationMs).toBeGreaterThanOrEqual(200);
      expect(result.peaks.length).toBeGreaterThan(0);
    });
  });
});
