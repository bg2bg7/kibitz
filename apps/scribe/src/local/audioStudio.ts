/**
 * Browser-side audio recording (MediaRecorder), duration/waveform decoding (Web Audio API),
 * and clip naming utilities for Scribe. Pure client-side — zero backend/auth dependencies.
 */

export interface RecordedAudioResult {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  durationMs: number;
  peaks: number[];
}

export interface ActiveRecordingSession {
  stop(): Promise<RecordedAudioResult>;
  cancel(): void;
  getLevel(): number;
}

const PREFERRED_RECORDING_MIMES = [
  "audio/ogg; codecs=opus",
  "audio/webm; codecs=opus",
  "audio/webm",
  "audio/mp4",
];

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

async function decodeWithContext(
  ctx: AudioContext | null,
  bytes: Uint8Array,
  fallbackDurationMs: number,
  bucketCount: number,
): Promise<{ durationMs: number; peaks: number[] }> {
  if (!ctx) {
    return makeFallbackMetadata(fallbackDurationMs, bucketCount);
  }
  try {
    const copy = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copy).set(bytes);
    const decoded = await ctx.decodeAudioData(copy);
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
    return makeFallbackMetadata(fallbackDurationMs, bucketCount);
  }
}

/**
 * Decodes raw audio bytes via Web Audio API to extract authoritative `durationMs` and
 * a downsampled peak array (0..1) for waveform display.
 */
export async function decodeAudioMetadata(
  bytes: Uint8Array,
  fallbackDurationMs = 2000,
  bucketCount = 64,
): Promise<{ durationMs: number; peaks: number[] }> {
  const AudioCtx = getAudioContextCtor();
  if (!AudioCtx) {
    return makeFallbackMetadata(fallbackDurationMs, bucketCount);
  }

  let ctx: AudioContext | null = null;
  try {
    ctx = new AudioCtx();
    return await decodeWithContext(ctx, bytes, fallbackDurationMs, bucketCount);
  } catch {
    return makeFallbackMetadata(fallbackDurationMs, bucketCount);
  } finally {
    if (ctx) {
      void ctx.close().catch(() => undefined);
    }
  }
}

/**
 * Decodes a batch of audio clips reusing a single Web Audio `AudioContext` so opening
 * multi-clip drafts/archives does not exhaust browser AudioContext limits.
 */
export async function decodeAudioMetadataBatch(
  items: ReadonlyArray<{ id: string; bytes: Uint8Array; fallbackDurationMs?: number }>,
  bucketCount = 64,
): Promise<Record<string, { durationMs: number; peaks: number[] }>> {
  const results: Record<string, { durationMs: number; peaks: number[] }> = {};
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
      results[item.id] = await decodeWithContext(
        ctx,
        item.bytes,
        item.fallbackDurationMs ?? 2000,
        bucketCount,
      );
    }
    return results;
  } finally {
    if (ctx) {
      void ctx.close().catch(() => undefined);
    }
  }
}

/**
 * Starts a microphone recording session using MediaRecorder + Web Audio AnalyserNode.
 */
export async function startMicRecording(): Promise<ActiveRecordingSession> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone recording is not supported in this browser.");
  }
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not available in this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chosenMime = pickSupportedRecordingMimeType();

  const chunks: Blob[] = [];
  let startedAt = Date.now();

  let analyser: AnalyserNode | null = null;
  let audioCtx: AudioContext | null = null;
  let dataArray: Uint8Array<ArrayBuffer> | null = null;

  const cleanup = () => {
    for (const track of stream.getTracks()) {
      track.stop();
    }
    if (audioCtx) {
      void audioCtx.close().catch(() => undefined);
      audioCtx = null;
    }
  };

  let recorder: MediaRecorder;
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
      if (ev.data.size > 0) {
        chunks.push(ev.data);
      }
    };

    startedAt = Date.now();
    recorder.start(100);
  } catch (err) {
    cleanup();
    throw err;
  }

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
    const meta = await decodeAudioMetadata(bytes, elapsedMs);
    return {
      bytes,
      mimeType: finalMime,
      extension: guessAudioExtension(finalMime),
      durationMs: meta.durationMs,
      peaks: meta.peaks,
    };
  };

  return {
    getLevel(): number {
      if (!analyser || !dataArray) return 0;
      analyser.getByteTimeDomainData(dataArray);
      let peak = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const centered = Math.abs((dataArray[i]! - 128) / 128);
        if (centered > peak) peak = centered;
      }
      return Math.min(1, peak * 2.2);
    },

    cancel(): void {
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      cleanup();
    },

    stop(): Promise<RecordedAudioResult> {
      if (recorder.state === "inactive") {
        return finalizeRecording();
      }

      return new Promise((resolve, reject) => {
        recorder.onstop = () => {
          finalizeRecording().then(resolve, reject);
        };
        recorder.onerror = () => {
          cleanup();
          reject(new Error("Audio recording failed."));
        };
        try {
          recorder.stop();
        } catch (err) {
          cleanup();
          reject(err instanceof Error ? err : new Error("Audio recording failed."));
        }
      });
    },
  };
}
