import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChessBoard,
  createTimelineAudioEngine,
  formatSquareAccessibleLabel,
  getNextBoardSquare,
  type ActiveAudioSlice,
} from "./index.js";

class MockHtmlAudioElement {
  static instances: MockHtmlAudioElement[] = [];

  src: string;
  duration = 3.0;
  readyState = 4;
  seeking = false;
  paused = true;
  ended = false;
  playCount = 0;
  pauseCount = 0;
  loadCount = 0;
  seekHistory: number[] = [];

  private _currentTime = 0;
  private listeners = new Map<string, Set<() => void>>();

  constructor(url = "") {
    this.src = url;
    MockHtmlAudioElement.instances.push(this);
  }

  get currentTime(): number {
    return this._currentTime;
  }

  set currentTime(value: number) {
    this._currentTime = value;
    this.seekHistory.push(value);
    if (Number.isFinite(this.duration) && value < this.duration) {
      this.ended = false;
    }
  }

  addEventListener(type: string, listener: () => void, options?: { once?: boolean }): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    if (options?.once) {
      const wrapped = () => {
        set?.delete(wrapped);
        listener();
      };
      set.add(wrapped);
    } else {
      set.add(listener);
    }
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    const handlers = [...(this.listeners.get(type) ?? [])];
    for (const handler of handlers) {
      handler();
    }
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  load(): void {
    this.loadCount += 1;
  }

  play(): Promise<void> {
    this.playCount += 1;
    this.paused = false;
    this.ended = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCount += 1;
    this.paused = true;
  }

  simulateEnded(atSec = this.duration): void {
    this._currentTime = atSec;
    this.paused = true;
    this.ended = true;
    this.emit("ended");
  }
}

describe("@suite/board-ui", () => {
  describe("formatSquareAccessibleLabel (UI-01)", () => {
    it("describes empty squares, piece colors/types, selection, and legal destinations", () => {
      expect(formatSquareAccessibleLabel("e4", null)).toBe("e4, empty");
      expect(formatSquareAccessibleLabel("e4", undefined)).toBe("e4, empty");
      expect(formatSquareAccessibleLabel("e2", { color: "w", type: "p" })).toBe("e2, White pawn");
      expect(formatSquareAccessibleLabel("g8", { color: "b", type: "n" })).toBe("g8, Black knight");
      expect(formatSquareAccessibleLabel("c1", { color: "w", type: "b" })).toBe("c1, White bishop");
      expect(formatSquareAccessibleLabel("a8", { color: "b", type: "r" })).toBe("a8, Black rook");
      expect(formatSquareAccessibleLabel("d1", { color: "w", type: "q" })).toBe("d1, White queen");
      expect(formatSquareAccessibleLabel("e8", { color: "b", type: "k" })).toBe("e8, Black king");

      expect(
        formatSquareAccessibleLabel("e2", { color: "w", type: "p" }, { selected: true }),
      ).toBe("e2, White pawn, selected");
      expect(formatSquareAccessibleLabel("e4", null, { isLegalTarget: true })).toBe(
        "e4, empty, legal destination",
      );
      expect(
        formatSquareAccessibleLabel("d5", { color: "b", type: "p" }, { isLegalTarget: true }),
      ).toBe("d5, Black pawn, legal destination");
    });
  });

  describe("getNextBoardSquare orientation-aware arrow navigation (UI-01)", () => {
    it("navigates and clamps properly from white perspective", () => {
      expect(getNextBoardSquare("e4", "ArrowUp", "white")).toBe("e5");
      expect(getNextBoardSquare("e4", "ArrowDown", "white")).toBe("e3");
      expect(getNextBoardSquare("e4", "ArrowLeft", "white")).toBe("d4");
      expect(getNextBoardSquare("e4", "ArrowRight", "white")).toBe("f4");

      // Board boundaries clamp in place
      expect(getNextBoardSquare("a8", "ArrowUp", "white")).toBe("a8");
      expect(getNextBoardSquare("a8", "ArrowLeft", "white")).toBe("a8");
      expect(getNextBoardSquare("h1", "ArrowDown", "white")).toBe("h1");
      expect(getNextBoardSquare("h1", "ArrowRight", "white")).toBe("h1");

      // Home / End and Ctrl+Home / Ctrl+End
      expect(getNextBoardSquare("e4", "Home", "white")).toBe("a4");
      expect(getNextBoardSquare("e4", "End", "white")).toBe("h4");
      expect(getNextBoardSquare("e4", "Home", "white", { ctrlKey: true })).toBe("a8");
      expect(getNextBoardSquare("e4", "End", "white", { ctrlKey: true })).toBe("h1");
    });

    it("inverts direction vectors properly from black perspective", () => {
      expect(getNextBoardSquare("e4", "ArrowUp", "black")).toBe("e3");
      expect(getNextBoardSquare("e4", "ArrowDown", "black")).toBe("e5");
      expect(getNextBoardSquare("e4", "ArrowLeft", "black")).toBe("f4");
      expect(getNextBoardSquare("e4", "ArrowRight", "black")).toBe("d4");

      // Board boundaries clamp in place (top-left is h1, bottom-right is a8)
      expect(getNextBoardSquare("h1", "ArrowUp", "black")).toBe("h1");
      expect(getNextBoardSquare("h1", "ArrowLeft", "black")).toBe("h1");
      expect(getNextBoardSquare("a8", "ArrowDown", "black")).toBe("a8");
      expect(getNextBoardSquare("a8", "ArrowRight", "black")).toBe("a8");

      expect(getNextBoardSquare("e4", "Home", "black")).toBe("h4");
      expect(getNextBoardSquare("e4", "End", "black")).toBe("a4");
      expect(getNextBoardSquare("e4", "Home", "black", { ctrlKey: true })).toBe("h1");
      expect(getNextBoardSquare("e4", "End", "black", { ctrlKey: true })).toBe("a8");
    });

    it("returns null for non-navigation keys or invalid coordinates", () => {
      expect(getNextBoardSquare("e4", "Enter", "white")).toBeNull();
      expect(getNextBoardSquare("e4", " ", "white")).toBeNull();
      expect(getNextBoardSquare("z9", "ArrowUp", "white")).toBeNull();
      expect(getNextBoardSquare("e44", "ArrowUp", "white")).toBeNull();
      expect(getNextBoardSquare("", "ArrowUp", "white")).toBeNull();
    });
  });

  describe("ChessBoard rendering & accessibility markup (UI-01)", () => {
    it("renders a 64-square board with accessible square labels, selection state, roving tabIndex, status region, arrows, and projector theme", () => {
      const html = renderToStaticMarkup(
        createElement(ChessBoard, {
          orientation: "black",
          theme: "projector-high-contrast",
          arrows: [{ color: "G", from: "e2", to: "e4" }],
          highlights: [{ color: "Y", square: "e4" }],
        }),
      );

      expect(html).toContain('data-theme="projector-high-contrast"');
      expect(html).toContain('data-orientation="black"');
      expect(html).toContain('role="group"');
      expect(html).toContain('aria-label="Chess board, black perspective"');
      expect(html).toContain("<svg");
      expect(html).toContain("<polygon");

      // 64 square buttons with descriptive aria-label and aria-pressed
      const squareMatches = html.match(/data-square="[a-h][1-8]"/g) ?? [];
      expect(squareMatches).toHaveLength(64);
      expect(html).toContain('aria-label="e4, empty"');
      expect(html).toContain('aria-label="e2, White pawn"');
      expect(html).toContain('aria-label="e7, Black pawn"');
      expect(html).toContain('aria-label="e1, White king"');
      expect(html).toContain('aria-label="d8, Black queen"');
      expect(html).toContain('aria-pressed="false"');

      // Roving tabIndex: only top-left square for black perspective (h1) has tabIndex=0
      const tabIndexZeroMatches = html.match(/tabIndex="0"|tabindex="0"/g) ?? [];
      expect(tabIndexZeroMatches).toHaveLength(1);
      expect(html).toMatch(/data-square="h1"[^>]*tabindex="0"/i);

      // Live status region for selection/move announcements
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('aria-atomic="true"');
      expect(html).toContain('data-testid="chess-board-status"');
    });

    it("sets initial roving tabIndex on a8 for white orientation", () => {
      const html = renderToStaticMarkup(createElement(ChessBoard, { orientation: "white" }));
      expect(html).toContain('aria-label="Chess board, white perspective"');
      expect(html).toMatch(/data-square="a8"[^>]*tabindex="0"/i);
    });
  });

  describe("createTimelineAudioEngine HTMLAudioElement fallback (UI-02)", () => {
    const originalAudio = globalThis.Audio;
    const originalAudioContext = globalThis.AudioContext;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;

    afterEach(() => {
      MockHtmlAudioElement.instances = [];
      globalThis.Audio = originalAudio;
      globalThis.AudioContext = originalAudioContext;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
      vi.restoreAllMocks();
    });

    const installFallbackMocks = () => {
      MockHtmlAudioElement.instances = [];
      // Disable Web Audio so the engine uses the HTMLAudioElement fallback path
      (globalThis as unknown as { AudioContext: unknown }).AudioContext = undefined;
      (globalThis as unknown as { Audio: unknown }).Audio = MockHtmlAudioElement;
      const revokedUrls: string[] = [];
      let blobCounter = 0;
      URL.createObjectURL = vi.fn(() => `blob:mock-${++blobCounter}`);
      URL.revokeObjectURL = vi.fn((url: string) => {
        revokedUrls.push(url);
      });
      return { revokedUrls };
    };

    const clip: ActiveAudioSlice = {
      path: "audio/clip1.ogg",
      trimStartMs: 0,
      trimEndMs: 5000,
    };
    const audioByPath = { "audio/clip1.ogg": new Uint8Array([1, 2, 3, 4]) };
    const clips = {
      clip1: { id: "clip1", path: "audio/clip1.ogg", mimeType: "audio/ogg", durationMs: 3000 },
    };

    const flushMicrotasks = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };

    it("resumes ended HTMLAudioElement fallback playback on backward seek while playing, without looping past end", async () => {
      const { revokedUrls } = installFallbackMocks();
      const engine = createTimelineAudioEngine(audioByPath, clips);

      // Start playback at 0ms
      engine.sync(true, clip, 0);
      await flushMicrotasks();
      expect(MockHtmlAudioElement.instances).toHaveLength(1);
      const el = MockHtmlAudioElement.instances[0]!;
      expect(el.playCount).toBe(1);
      expect(el.paused).toBe(false);

      // Audio naturally ends at 3.0s (shorter than 5.0s trimEndMs)
      el.simulateEnded(3.0);
      expect(el.ended).toBe(true);
      expect(el.paused).toBe(true);

      // Playback clock advances past actual clip end (3.6s): must stay ended, no replay or seek thrash
      engine.sync(true, clip, 3600);
      expect(el.playCount).toBe(1);
      expect(el.paused).toBe(true);
      expect(el.seekHistory).toEqual([]);

      // User seeks backward to 1.2s while still playing -> must seek & call play() to resume
      engine.sync(true, clip, 1200);
      expect(el.currentTime).toBeCloseTo(1.2, 5);
      expect(el.playCount).toBe(2);
      expect(el.paused).toBe(false);
      expect(el.ended).toBe(false);

      // End again, then test a small backward seek (2.8s < 3.0s - 0.1s)
      el.simulateEnded(3.0);
      engine.sync(true, clip, 2800);
      expect(el.currentTime).toBeCloseTo(2.8, 5);
      expect(el.playCount).toBe(3);
      expect(el.paused).toBe(false);

      // Also handle native el.ended = true even before an "ended" listener fires
      el.currentTime = 3.0;
      el.paused = true;
      el.ended = true;
      engine.sync(true, clip, 1500);
      expect(el.currentTime).toBeCloseTo(1.5, 5);
      expect(el.playCount).toBe(4);
      expect(el.paused).toBe(false);

      engine.dispose();
      expect(el.listenerCount("ended")).toBe(0);
      expect(el.pauseCount).toBeGreaterThanOrEqual(1);
      expect(revokedUrls).toEqual(["blob:mock-1"]);
    });

    it("stays silent on backward seek while user-paused", async () => {
      installFallbackMocks();
      const engine = createTimelineAudioEngine(audioByPath, clips);

      // Play until ended
      engine.sync(true, clip, 0);
      await flushMicrotasks();
      const firstEl = MockHtmlAudioElement.instances[0]!;
      expect(firstEl.playCount).toBe(1);
      firstEl.simulateEnded(3.0);

      // User pauses
      engine.sync(false, clip, 3000);
      expect(firstEl.pauseCount).toBe(1);
      expect(firstEl.playCount).toBe(1);

      // User seeks backward repeatedly while paused -> must remain completely silent
      engine.sync(false, clip, 1500);
      engine.sync(false, clip, 500);
      expect(MockHtmlAudioElement.instances).toHaveLength(1);
      expect(firstEl.playCount).toBe(1);

      // Direct transition from ended playing state to paused backward seek must also stay silent
      engine.sync(true, clip, 500);
      await flushMicrotasks();
      expect(MockHtmlAudioElement.instances).toHaveLength(2);
      const secondEl = MockHtmlAudioElement.instances[1]!;
      expect(secondEl.playCount).toBe(1);
      secondEl.simulateEnded(3.0);

      engine.sync(false, clip, 1000);
      expect(secondEl.pauseCount).toBe(1);
      expect(secondEl.playCount).toBe(1);
      expect(MockHtmlAudioElement.instances).toHaveLength(2);

      engine.dispose();
    });

    it("does not start delayed fallback playback if paused before loadedmetadata fires", async () => {
      installFallbackMocks();

      class PendingMetadataAudio extends MockHtmlAudioElement {
        constructor(url = "") {
          super(url);
          this.readyState = 0;
        }
      }
      (globalThis as unknown as { Audio: unknown }).Audio = PendingMetadataAudio;

      const engine = createTimelineAudioEngine(audioByPath, clips);

      // Start at 1.0s with readyState=0 -> defers play() until loadedmetadata
      engine.sync(true, clip, 1000);
      await flushMicrotasks();
      expect(MockHtmlAudioElement.instances).toHaveLength(1);
      const el = MockHtmlAudioElement.instances[0]!;
      expect(el.loadCount).toBe(1);
      expect(el.playCount).toBe(0);

      // User pauses before metadata loads
      engine.sync(false, clip, 1000);

      // Metadata arrives late -> must NOT call play()
      el.readyState = 1;
      el.emit("loadedmetadata");
      expect(el.playCount).toBe(0);
      expect(el.paused).toBe(true);

      engine.dispose();
    });
  });
});
