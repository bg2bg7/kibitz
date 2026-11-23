/**
 * Browser-side audio recording (MediaRecorder), duration/waveform decoding (Web Audio API
 * with HTML <audio> metadata fallback), and clip naming utilities for Scribe.
 * Pure client-side — zero backend/auth dependencies.
 */

export type AudioDurationSource = "webaudio" | "html-audio" | "fallback";

export interface DecodedAudioMetadata {
  durationMs: number;
  peaks: number[];
  durationSource: AudioDurationSource;
}

export interface DecodeAudioMetadataOptions {
  strictDuration?: boolean;
  mimeType?: string;
}

export interface RecordedAudioResult {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  durationMs: number;
  peaks: number[];
}

export interface StartMicRecordingOptions {
  onInterrupted?: (reason: string) => void;
  signal?: AbortSignal;
}

export interface ActiveRecordingSession {
  stop(): Promise<RecordedAudioResult>;
  cancel(): void;
  getLevel(): number;
  isActive(): boolean;
}

const PREFERRED_RECORDING_MIMES = [
  "audio/ogg; codecs=opus",
  "audio/webm; codecs=opus",
  "audio/webm",
  "audio/mp4",
];

const STRICT_DECODE_ERROR_MESSAGE =
  "Could not decode audio duration. The file may be corrupted or in an unsupported audio format.";

const HTML_AUDIO_PROBE_TIMEOUT_MS = 5000;

export function pickSupportedRecordingMimeType(): string {
  if (typeof MediaRecorder === "undefined") {
    return "audio/webm; codecs=opus";
  }
  for (const mime of PREFERRED_RECORDING_MIMES) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return "";
}

export function guessAudioExtension(mimeType: string, fileName?: string): string {
  if (fileName) {
    const dot = fileName.lastIndexOf(".");
    if (dot !== -1 && dot < fileName.length - 1) {
      const ext = fileName
        .slice(dot + 1)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      if (ext.length > 0 && ext.length <= 5) {
        return ext;
      }
    }
  }
  const lower = mimeType.toLowerCase();
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("webm")) return "webm";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  if (lower.includes("mp4") || lower.includes("m4a") || lower.includes("aac")) return "m4a";
  return "webm";
}

export function generateClipId(existingIds: Iterable<string>): string {
  const used = new Set(existingIds);
  for (let i = 1; i < 10000; i++) {
    const candidate = `clip-${String(i).padStart(3, "0")}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return `clip-${Date.now().toString(36)}`;
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  return typeof AudioContext !== "undefined"
    ? AudioContext
    : (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

function makeFallbackMetadata(
  fallbackDurationMs: number,
  bucketCount: number,
): { durationMs: number; peaks: number[] } {
  return {
    durationMs: Math.max(100, Math.round(fallbackDurationMs)),
    peaks: Array.from({ length: bucketCount }, () => 0.35),
  };
}

/**
 * Probes audio duration using the browser HTML `<audio>` element's `loadedmetadata` event.
 * Safely returns `null` when DOM audio / object URLs are unavailable or the media cannot
 * provide a finite positive duration.
 */
export async function probeHtmlAudioDurationMs(
  bytes: Uint8Array,
  mimeType?: string,
): Promise<number | null> {
  if (
    bytes.byteLength === 0 ||
    typeof Audio === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return null;
  }

  let objectUrl: string | null = null;
  try {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy], mimeType ? { type: mimeType } : undefined);
    objectUrl = URL.createObjectURL(blob);

    const url = objectUrl;
    return await new Promise<number | null>((resolve) => {
      let settled = false;
      const audio = new Audio();
      audio.preload = "metadata";

      const cleanupListeners = () => {
        if (typeof audio.removeEventListener === "function") {
          audio.removeEventListener("loadedmetadata", onLoadedMetadata);
          audio.removeEventListener("error", onError);
        }
        audio.onloadedmetadata = null;
        audio.onerror = null;
      };

      const finish = (durationMs: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanupListeners();
        try {
          audio.src = "";
        } catch {
          // ignore cleanup failures on detached mock audio elements
        }
        resolve(durationMs);
      };

      const onLoadedMetadata = () => {
        const sec = audio.duration;
        if (typeof sec === "number" && Number.isFinite(sec) && sec > 0) {
          finish(Math.max(100, Math.round(sec * 1000)));
        } else {
          finish(null);
        }
      };

      const onError = () => {
        finish(null);
      };

      const timer = setTimeout(() => {
        finish(null);
      }, HTML_AUDIO_PROBE_TIMEOUT_MS);

      if (typeof audio.addEventListener === "function") {
        audio.addEventListener("loadedmetadata", onLoadedMetadata);
        audio.addEventListener("error", onError);
      } else {
        audio.onloadedmetadata = onLoadedMetadata;
        audio.onerror = onError;
      }

      try {
        audio.src = url;
        if (typeof audio.load === "function") {
          audio.load();
        }
      } catch {
        finish(null);
      }
    });
  } catch {
    return null;
  } finally {
    if (objectUrl && typeof URL.revokeObjectURL === "function") {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // ignore object URL revocation errors
      }
    }
  }
}

async function tryDecodeWithContext(
  ctx: AudioContext | null,
  bytes: Uint8Array,
  bucketCount: number,
): Promise<{ durationMs: number; peaks: number[] } | null> {
  if (!ctx || bytes.byteLength === 0) {
    return null;
  }
  try {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const decoded = await ctx.decodeAudioData(copy);
    if (
      typeof decoded.duration !== "number" ||
      !Number.isFinite(decoded.duration) ||
      decoded.duration <= 0
    ) {
      return null;
    }
    const durationMs = Math.max(100, Math.round(decoded.duration * 1000));
    const channel = decoded.getChannelData(0);
    const step = Math.max(1, Math.floor(channel.length / bucketCount));
    const peaks: number[] = [];
    for (let i = 0; i < bucketCount; i++) {
      let maxAbs = 0;
      const start = i * step;
      const end = Math.min(channel.length, start + step);
      for (let j = start; j < end; j++) {
        const abs = Math.abs(channel[j] ?? 0);
        if (abs > maxAbs) maxAbs = abs;
      }
      peaks.push(Math.min(1, Math.max(0.06, maxAbs)));
    }
    return { durationMs, peaks };
  } catch {
    return null;
  }
}

/**
 * Decodes raw audio bytes via Web Audio API (with an HTML `<audio>` `loadedmetadata` fallback)
 * to extract authoritative `durationMs` and a downsampled peak array (0..1) for waveform display.
 * When `options.strictDuration` is true, throws instead of inventing a guessed fallback duration.
 */
export async function decodeAudioMetadata(
  bytes: Uint8Array,
  fallbackDurationMs = 2000,
  bucketCount = 64,
  options?: DecodeAudioMetadataOptions,
): Promise<DecodedAudioMetadata> {
  const AudioCtx = getAudioContextCtor();
  if (AudioCtx) {
    let ctx: AudioContext | null = null;
    try {
      ctx = new AudioCtx();
      const decoded = await tryDecodeWithContext(ctx, bytes, bucketCount);
      if (decoded) {
        return {
          ...decoded,
          durationSource: "webaudio",
        };
      }
    } catch {
      // fall through to HTML <audio> metadata probe
    } finally {
      if (ctx) {
        void ctx.close().catch(() => undefined);
      }
    }
  }

  const probedDurationMs = await probeHtmlAudioDurationMs(bytes, options?.mimeType);
  if (probedDurationMs !== null) {
    return {
      durationMs: probedDurationMs,
      peaks: makeFallbackMetadata(probedDurationMs, bucketCount).peaks,
      durationSource: "html-audio",
    };
  }

  if (options?.strictDuration === true) {
    throw new Error(STRICT_DECODE_ERROR_MESSAGE);
  }

  return {
    ...makeFallbackMetadata(fallbackDurationMs, bucketCount),
    durationSource: "fallback",
  };
}

/**
 * Decodes a batch of audio clips reusing a single Web Audio `AudioContext` so opening
 * multi-clip drafts/archives does not exhaust browser AudioContext limits.
 */
export async function decodeAudioMetadataBatch(
  items: ReadonlyArray<{
    id: string;
    bytes: Uint8Array;
    fallbackDurationMs?: number;
    mimeType?: string;
  }>,
  bucketCount = 64,
): Promise<Record<string, DecodedAudioMetadata>> {
  const results: Record<string, DecodedAudioMetadata> = {};
  if (items.length === 0) {
    return results;
  }

  const AudioCtx = getAudioContextCtor();
  let ctx: AudioContext | null = null;
  if (AudioCtx) {
    try {
      ctx = new AudioCtx();
    } catch {
      ctx = null;
    }
  }

  try {
    for (const item of items) {
      const decoded = await tryDecodeWithContext(ctx, item.bytes, bucketCount);
      if (decoded) {
        results[item.id] = {
          ...decoded,
          durationSource: "webaudio",
        };
        continue;
      }

      const probedDurationMs = await probeHtmlAudioDurationMs(item.bytes, item.mimeType);
      if (probedDurationMs !== null) {
        results[item.id] = {
          durationMs: probedDurationMs,
          peaks: makeFallbackMetadata(probedDurationMs, bucketCount).peaks,
          durationSource: "html-audio",
        };
        continue;
      }

      results[item.id] = {
        ...makeFallbackMetadata(item.fallbackDurationMs ?? 2000, bucketCount),
        durationSource: "fallback",
      };
    }
    return results;
  } finally {
    if (ctx) {
      void ctx.close().catch(() => undefined);
    }
  }
}

type RecordingState = "recording" | "stopping" | "stopped" | "cancelled" | "interrupted";

function stopStreamTracks(stream: MediaStream): void {
  const tracks = typeof stream.getTracks === "function" ? stream.getTracks() : [];
  for (const track of tracks) {
    try {
      track.stop();
    } catch {
      // ignore errors when stopping already-ended tracks
    }
  }
}

/**
 * Starts a microphone recording session using MediaRecorder + Web Audio AnalyserNode,
 * with explicit abort handling during permission acquisition and terminal error/ended
 * listeners installed before capture begins.
 */
export async function startMicRecording(
  options?: StartMicRecordingOptions,
): Promise<ActiveRecordingSession> {
  if (options?.signal?.aborted) {
    throw new Error("Recording cancelled before microphone access.");
  }

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone recording is not supported in this browser.");
  }
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not available in this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  if (options?.signal?.aborted) {
    stopStreamTracks(stream);
    throw new Error("Recording cancelled before microphone access.");
  }

  const chosenMime = pickSupportedRecordingMimeType();
  const chunks: Blob[] = [];
  let startedAt = Date.now();

  let state: RecordingState = "recording";
  let interruptionReason: string | null = null;
  let interruptionNotified = false;
  let cleanedUp = false;

  let analyser: AnalyserNode | null = null;
  let audioCtx: AudioContext | null = null;
  let dataArray: Uint8Array<ArrayBuffer> | null = null;

  let pendingStopResolve: ((result: RecordedAudioResult) => void) | null = null;
  let pendingStopReject: ((error: Error) => void) | null = null;
  let pendingStopPromise: Promise<RecordedAudioResult> | null = null;

  const allTracks = typeof stream.getTracks === "function" ? stream.getTracks() : [];
  const audioTracks =
    typeof stream.getAudioTracks === "function"
      ? stream.getAudioTracks()
      : allTracks.filter((track) => !("kind" in track) || track.kind === "audio");

  const notifyInterrupted = (reason: string) => {
    if (interruptionNotified) return;
    interruptionNotified = true;
    options?.onInterrupted?.(reason);
  };

  const rejectPendingStop = (error: Error) => {
    const reject = pendingStopReject;
    pendingStopResolve = null;
    pendingStopReject = null;
    if (reject) {
      reject(error);
    }
  };

  let recorder!: MediaRecorder;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;

    if (options?.signal) {
      options.signal.removeEventListener("abort", onSignalAbort);
    }

    for (const track of audioTracks) {
      if (typeof track.removeEventListener === "function") {
        track.removeEventListener("ended", onTrackEnded);
      }
    }

    stopStreamTracks(stream);

    if (audioCtx) {
      const ctxToClose = audioCtx;
      audioCtx = null;
      analyser = null;
      dataArray = null;
      void ctxToClose.close().catch(() => undefined);
    } else {
      analyser = null;
      dataArray = null;
    }
  };

  const cancelSession = () => {
    if (state === "stopped" || state === "cancelled" || state === "interrupted") {
      cleanup();
      return;
    }
    state = "cancelled";
    rejectPendingStop(new Error("Recording was cancelled."));
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // ignore stop error during cancellation
      }
    }
    cleanup();
  };

  const onSignalAbort = () => {
    cancelSession();
  };

  const onTrackEnded = () => {
    if (state !== "recording") return;
    const reason = "Microphone stream ended unexpectedly.";
    state = "interrupted";
    interruptionReason = reason;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // ignore stop error after track ended
      }
    }
    cleanup();
    rejectPendingStop(new Error(reason));
    notifyInterrupted(reason);
  };

  const finalizeRecording = async (): Promise<RecordedAudioResult> => {
    const elapsedMs = Math.max(200, Date.now() - startedAt);
    const finalMime = recorder.mimeType || chosenMime || "audio/webm";
    const blob = new Blob(chunks, { type: finalMime });
    cleanup();
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (bytes.byteLength === 0) {
      throw new Error("Recorded audio was empty.");
    }
    const meta = await decodeAudioMetadata(bytes, elapsedMs, 64, { mimeType: finalMime });
    return {
      bytes,
      mimeType: finalMime,
      extension: guessAudioExtension(finalMime),
      durationMs: meta.durationMs,
      peaks: meta.peaks,
    };
  };

  try {
    recorder = chosenMime
      ? new MediaRecorder(stream, { mimeType: chosenMime })
      : new MediaRecorder(stream);

    const AudioCtx = getAudioContextCtor();
    if (AudioCtx) {
      try {
        audioCtx = new AudioCtx();
        const source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        dataArray = new Uint8Array(analyser.frequencyBinCount);
      } catch {
        if (audioCtx) {
          void audioCtx.close().catch(() => undefined);
        }
        audioCtx = null;
        analyser = null;
      }
    }

    recorder.ondataavailable = (ev) => {
      if ((state === "recording" || state === "stopping") && ev.data.size > 0) {
        chunks.push(ev.data);
      }
    };

    recorder.onerror = () => {
      if (state === "cancelled" || state === "stopped") {
        cleanup();
        return;
      }
      const reason = "Microphone recording failed due to a device error.";
      state = "interrupted";
      if (!interruptionReason) {
        interruptionReason = reason;
      }
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // ignore stop error after device error
        }
      }
      cleanup();
      rejectPendingStop(new Error(interruptionReason));
      notifyInterrupted(interruptionReason);
    };

    recorder.onstop = () => {
      if (state === "stopping") {
        state = "stopped";
        const resolve = pendingStopResolve;
        const reject = pendingStopReject;
        pendingStopResolve = null;
        pendingStopReject = null;
        if (resolve && reject) {
          finalizeRecording().then(resolve, reject);
        } else {
          cleanup();
        }
        return;
      }

      if (state === "recording") {
        const reason = "Recording stopped unexpectedly before completion.";
        state = "interrupted";
        interruptionReason = reason;
        cleanup();
        notifyInterrupted(reason);
        return;
      }

      cleanup();
      if (pendingStopReject) {
        rejectPendingStop(
          new Error(
            state === "cancelled"
              ? "Recording was cancelled."
              : (interruptionReason ?? "Recording was interrupted."),
          ),
        );
      }
    };

    for (const track of audioTracks) {
      if (typeof track.addEventListener === "function") {
        track.addEventListener("ended", onTrackEnded);
      }
    }

    if (options?.signal) {
      options.signal.addEventListener("abort", onSignalAbort, { once: true });
    }

    startedAt = Date.now();
    recorder.start(100);
  } catch (err) {
    state = "cancelled";
    cleanup();
    throw err;
  }

  return {
    isActive(): boolean {
      return state === "recording";
    },

    getLevel(): number {
      if (state !== "recording" || !analyser || !dataArray) return 0;
      analyser.getByteTimeDomainData(dataArray);
      let peak = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const centered = Math.abs((dataArray[i]! - 128) / 128);
        if (centered > peak) peak = centered;
      }
      return Math.min(1, peak * 2.2);
    },

    cancel(): void {
      cancelSession();
    },

    stop(): Promise<RecordedAudioResult> {
      if (state === "interrupted") {
        return Promise.reject(new Error(interruptionReason ?? "Recording was interrupted."));
      }
      if (state === "cancelled") {
        return Promise.reject(new Error("Recording was cancelled."));
      }
      if (state === "stopping" || state === "stopped") {
        if (pendingStopPromise) {
          return pendingStopPromise;
        }
        return Promise.reject(new Error("Recording has already stopped."));
      }

      state = "stopping";
      pendingStopPromise = new Promise<RecordedAudioResult>((resolve, reject) => {
        pendingStopResolve = resolve;
        pendingStopReject = reject;
        try {
          if (recorder.state === "inactive") {
            state = "stopped";
            pendingStopResolve = null;
            pendingStopReject = null;
            void finalizeRecording().then(resolve, reject);
            return;
          }
          recorder.stop();
        } catch (err) {
          const error = err instanceof Error ? err : new Error("Audio recording failed.");
          state = "interrupted";
          interruptionReason = error.message;
          cleanup();
          pendingStopResolve = null;
          pendingStopReject = null;
          reject(error);
        }
      });
      return pendingStopPromise;
    },
  };
}
