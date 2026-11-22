import type { ClipDefinition, ResolvedClipAudio } from "@suite/pgna";

/**
 * Multi-clip audio playback engine for PGNA timeline & manual playback.
 *
 * Uses a single unlocked Web Audio `AudioContext` + pre-decoded `AudioBufferSourceNode`s so:
 * - Transitioning across clips 1 -> 2 -> 3 -> ... never hits HTMLMediaElement `src`-swap races,
 *   stale `currentTime`/`paused` state, MediaRecorder WebM seek bugs, or post-gesture autoplay blocks.
 * - `trimStartMs` and `trimEndMs` are sample-accurate via `source.start(0, offsetSec, durationSec)`.
 * - Falls back cleanly to per-clip `HTMLAudioElement` if Web Audio decoding fails.
 */
export interface TimelineAudioEngine {
  /** Call synchronously inside user gesture handlers (Play click, seek, guess move) to unlock Web Audio. */
  unlock(): void;
  /** Synchronizes audio output with the current PGNA playback snapshot. */
  sync(
    isPlaying: boolean,
    activeAudio: ResolvedClipAudio | null,
    audioTimeMs: number | null,
  ): void;
  /** Stops playback and releases AudioContext + Blob URLs. */
  dispose(): void;
}

const DRIFT_RESYNC_SEC = 0.35;

export function createTimelineAudioEngine(
  audioByPath: Readonly<Record<string, Uint8Array>>,
  clips: Readonly<Record<string, ClipDefinition>>,
): TimelineAudioEngine {
  const AudioCtx =
    typeof AudioContext !== "undefined"
      ? AudioContext
      : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  let audioCtx: AudioContext | null = null;
  let disposed = false;

  // Decoded PCM buffers cache (null means decodeAudioData failed -> use HTMLAudioElement fallback)
  const decodedBuffers = new Map<string, AudioBuffer | null>();
  const decodePromises = new Map<string, Promise<AudioBuffer | null>>();

  // Lazy Blob URLs only needed for HTMLAudioElement fallback
  const blobUrls = new Map<string, string>();

  // Active playback state
  let activeToken = 0;
  let currentClipKey: string | null = null;
  let currentSource: AudioBufferSourceNode | null = null;
  let currentStartOffsetSec = 0;
  let currentStartCtxTime = 0;
  let sourceEnded = false;
  let lastEndedOffsetSec = 0;
  let fallbackEl: HTMLAudioElement | null = null;

  // Latest desired state (used if an async decode finishes mid-clip)
  let latestIsPlaying = false;
  let latestAudio: ResolvedClipAudio | null = null;
  let latestAudioTimeMs: number | null = null;

  const ensureAudioContext = (): AudioContext | null => {
    if (disposed || !AudioCtx) return null;
    if (!audioCtx) {
      try {
        audioCtx = new AudioCtx();
      } catch {
        audioCtx = null;
      }
    }
    return audioCtx;
  };

  const getMimeTypeForPath = (path: string): string => {
    for (const clip of Object.values(clips)) {
      if (clip.path === path && clip.mimeType) {
        return clip.mimeType;
      }
    }
    return "audio/ogg";
  };

  const getBlobUrl = (path: string): string | null => {
    const existing = blobUrls.get(path);
    if (existing) return existing;
    const bytes = audioByPath[path];
    if (!bytes) return null;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const url = URL.createObjectURL(new Blob([copy], { type: getMimeTypeForPath(path) }));
    blobUrls.set(path, url);
    return url;
  };

  const decodeClip = (path: string): Promise<AudioBuffer | null> => {
    if (decodedBuffers.has(path)) {
      return Promise.resolve(decodedBuffers.get(path) ?? null);
    }
    const inFlight = decodePromises.get(path);
    if (inFlight) return inFlight;

    const bytes = audioByPath[path];
    const ctx = ensureAudioContext();
    if (!bytes || !ctx) {
      decodedBuffers.set(path, null);
      return Promise.resolve(null);
    }

    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);

    const promise = ctx
      .decodeAudioData(copy)
      .then((buffer) => {
        decodedBuffers.set(path, buffer);
        decodePromises.delete(path);
        return buffer;
      })
      .catch(() => {
        decodedBuffers.set(path, null);
        decodePromises.delete(path);
        return null;
      });

    decodePromises.set(path, promise);
    return promise;
  };

  // Eagerly pre-decode all audio clips if AudioContext can be created
  if (AudioCtx && Object.keys(audioByPath).length > 0) {
    for (const path of Object.keys(audioByPath)) {
      void decodeClip(path);
    }
  }

  const stopActivePlayback = () => {
    activeToken++;
    currentClipKey = null;
    sourceEnded = false;
    lastEndedOffsetSec = 0;

    if (currentSource) {
      try {
        currentSource.onended = null;
        currentSource.stop();
      } catch {
        // already stopped
      }
      try {
        currentSource.disconnect();
      } catch {
        // ignore
      }
      currentSource = null;
    }

    if (fallbackEl) {
      try {
        fallbackEl.pause();
        fallbackEl.src = "";
      } catch {
        // ignore
      }
      fallbackEl = null;
    }
  };

  const startFallbackHtmlAudio = (
    audio: ResolvedClipAudio,
    offsetSec: number,
    token: number,
  ) => {
    if (disposed || token !== activeToken) return;
    const url = getBlobUrl(audio.path);
    if (!url || typeof Audio === "undefined") return;

    const el = new Audio(url);
    fallbackEl = el;

    const startPlayback = () => {
      if (disposed || token !== activeToken || fallbackEl !== el) return;
      if (offsetSec > 0.05) {
        try {
          el.currentTime = offsetSec;
        } catch {
          // ignore unseekable streams
        }
      }
      void el.play().catch(() => undefined);
    };

    if (offsetSec > 0.05 && el.readyState < 1) {
      el.addEventListener("loadedmetadata", startPlayback, { once: true });
      el.load();
    } else {
      startPlayback();
    }
  };

  const startBufferSource = (
    buffer: AudioBuffer,
    audio: ResolvedClipAudio,
    offsetSec: number,
    token: number,
  ) => {
    if (disposed || token !== activeToken) return;
    const ctx = ensureAudioContext();
    if (!ctx) return;

    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => undefined);
    }

    const trimEndSec = Math.min(buffer.duration, audio.trimEndMs / 1000);
    const safeOffset = Math.max(0, Math.min(offsetSec, Math.max(0, trimEndSec - 0.005)));
    const remainingSec = trimEndSec - safeOffset;
    if (remainingSec <= 0.005) {
      sourceEnded = true;
      lastEndedOffsetSec = trimEndSec;
      return;
    }

    sourceEnded = false;
    lastEndedOffsetSec = 0;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (currentSource === source) {
        currentSource = null;
        sourceEnded = true;
        lastEndedOffsetSec = trimEndSec;
      }
    };

    currentSource = source;
    currentStartOffsetSec = safeOffset;
    currentStartCtxTime = ctx.currentTime;
    source.start(0, safeOffset, remainingSec);
  };

  const beginClipPlayback = (audio: ResolvedClipAudio, offsetSec: number) => {
    stopActivePlayback();
    const clipKey = `${audio.path}|${audio.trimStartMs}|${audio.trimEndMs}`;
    currentClipKey = clipKey;
    const token = activeToken;

    if (decodedBuffers.has(audio.path)) {
      const buf = decodedBuffers.get(audio.path) ?? null;
      if (buf) {
        startBufferSource(buf, audio, offsetSec, token);
      } else {
        startFallbackHtmlAudio(audio, offsetSec, token);
      }
      return;
    }

    // Buffer still decoding: start as soon as it resolves at the latest live offset
    void decodeClip(audio.path).then((buf) => {
      if (disposed || token !== activeToken || !latestIsPlaying || !latestAudio) return;
      const liveOffsetSec =
        latestAudioTimeMs !== null ? latestAudioTimeMs / 1000 : offsetSec;
      if (buf) {
        startBufferSource(buf, latestAudio, liveOffsetSec, token);
      } else {
        startFallbackHtmlAudio(latestAudio, liveOffsetSec, token);
      }
    });
  };

  return {
    unlock() {
      const ctx = ensureAudioContext();
      if (ctx && ctx.state === "suspended") {
        void ctx.resume().catch(() => undefined);
      }
    },

    sync(isPlaying, activeAudio, audioTimeMs) {
      latestIsPlaying = isPlaying;
      latestAudio = activeAudio;
      latestAudioTimeMs = audioTimeMs;

      if (disposed || !isPlaying || !activeAudio || audioTimeMs === null) {
        if (currentClipKey !== null || currentSource !== null || fallbackEl !== null) {
          stopActivePlayback();
        }
        return;
      }

      const desiredSec = audioTimeMs / 1000;
      const trimEndSec = activeAudio.trimEndMs / 1000;
      if (trimEndSec - desiredSec <= 0.01) {
        if (currentClipKey !== null) {
          stopActivePlayback();
        }
        return;
      }

      const clipKey = `${activeAudio.path}|${activeAudio.trimStartMs}|${activeAudio.trimEndMs}`;

      // New clip (or resuming after pause / gap / silent revisit)
      if (currentClipKey !== clipKey) {
        beginClipPlayback(activeAudio, desiredSec);
        return;
      }

      // Same clip already active: only resync if user scrubbed/jumped beyond drift threshold
      if (currentSource && audioCtx) {
        const liveSec = currentStartOffsetSec + (audioCtx.currentTime - currentStartCtxTime);
        if (Math.abs(liveSec - desiredSec) > DRIFT_RESYNC_SEC) {
          beginClipPlayback(activeAudio, desiredSec);
        }
      } else if (fallbackEl) {
        if (
          fallbackEl.readyState >= 1 &&
          !fallbackEl.seeking &&
          Math.abs(fallbackEl.currentTime - desiredSec) > DRIFT_RESYNC_SEC
        ) {
          try {
            fallbackEl.currentTime = desiredSec;
          } catch {
            // ignore
          }
        }
      } else if (
        currentSource === null &&
        fallbackEl === null &&
        !decodePromises.has(activeAudio.path) &&
        sourceEnded &&
        desiredSec < lastEndedOffsetSec - 0.1
      ) {
        beginClipPlayback(activeAudio, desiredSec);
      }
    },

    dispose() {
      disposed = true;
      stopActivePlayback();
      if (audioCtx) {
        void audioCtx.close().catch(() => undefined);
        audioCtx = null;
      }
      for (const url of blobUrls.values()) {
        URL.revokeObjectURL(url);
      }
      blobUrls.clear();
      decodedBuffers.clear();
      decodePromises.clear();
    },
  };
}
