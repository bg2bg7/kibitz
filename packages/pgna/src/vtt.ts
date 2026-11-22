import type { TimelineEntry, WebVttCue } from "./types.js";
import { isValidSubtitleLang } from "./validator.js";

const VTT_TIMESTAMP_RE =
  /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/;
const VTT_NON_CUE_BLOCK_RE = /^(?:WEBVTT|NOTE|STYLE|REGION)(?:$|\s)/;

export function parseVttTimestampMs(raw: string): number | null {
  const match = VTT_TIMESTAMP_RE.exec(raw.trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const mins = Number(match[2]);
  const secs = Number(match[3]);
  const ms = Number(match[4]);
  return ((hours * 60 + mins) * 60 + secs) * 1000 + ms;
}

export function formatVttTimestampMs(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const mins = Math.floor((safe % 3_600_000) / 60_000);
  const secs = Math.floor((safe % 60_000) / 1000);
  const remMs = safe % 1000;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const pad3 = (n: number) => String(n).padStart(3, "0");
  return `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}.${pad3(remMs)}`;
}

/**
 * Parses WebVTT text into structured cues (handles optional cue IDs, settings, and NOTE blocks).
 */
export function parseWebVtt(vttText: string): WebVttCue[] {
  const normalized = vttText.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues: WebVttCue[] = [];

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((l) => l.trimEnd());
    while (lines.length > 0 && lines[0]!.trim() === "") {
      lines.shift();
    }
    if (lines.length === 0) continue;

    const first = lines[0]!.trim();
    if (VTT_NON_CUE_BLOCK_RE.test(first)) {
      continue;
    }

    let timingLineIdx = 0;
    if (!first.includes("-->")) {
      if (lines.length < 2 || !lines[1]!.includes("-->")) {
        continue;
      }
      timingLineIdx = 1;
    }

    const timingLine = lines[timingLineIdx]!;
    const arrowIdx = timingLine.indexOf("-->");
    if (arrowIdx === -1) continue;

    const startPart = timingLine.slice(0, arrowIdx).trim();
    const afterArrow = timingLine.slice(arrowIdx + 3).trim().split(/\s+/)[0] ?? "";
    const startMs = parseVttTimestampMs(startPart);
    const endMs = parseVttTimestampMs(afterArrow);
    if (startMs === null || endMs === null || endMs <= startMs) {
      continue;
    }

    const text = lines
      .slice(timingLineIdx + 1)
      .join("\n")
      .trim();
    if (text.length === 0) continue;

    cues.push({ startMs, endMs, text });
  }

  cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return cues;
}

export function serializeWebVtt(cues: readonly WebVttCue[]): string {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  if (sorted.length === 0) {
    return "WEBVTT\n";
  }
  const blocks = sorted.map(
    (cue) => `${formatVttTimestampMs(cue.startMs)} --> ${formatVttTimestampMs(cue.endMs)}\n${cue.text}`,
  );
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

/**
 * Merges per-clip WebVTT subtitle tracks into global `subtitles/<lang>/timeline.vtt` tracks
 * per PGNA v1.0 §7:
 * - Silent entries and silent revisits (`isRevisit: true` / `audio: null`) emit no cues.
 * - Cues outside `[trimStartMs, trimEndMs]` are dropped.
 * - Overlapping cues are clamped to `[trimStartMs, trimEndMs]` and shifted by `entry.startMs - trimStartMs`.
 */
export function mergeTimelineSubtitles(
  entries: readonly TimelineEntry[],
  subtitlesByPath: Readonly<Record<string, string>>,
): { mergedSubtitlesPaths: Record<string, string>; mergedSubtitlesVtt: Record<string, string> } {
  const cuesByLang = new Map<string, WebVttCue[]>();

  for (const entry of entries) {
    if (!entry.audio || entry.isRevisit || !entry.subtitles) {
      continue;
    }

    const { trimStartMs, trimEndMs } = entry.audio;
    const shiftMs = entry.startMs - trimStartMs;

    for (const [lang, subPath] of Object.entries(entry.subtitles)) {
      if (!isValidSubtitleLang(lang)) {
        continue;
      }
      const rawVtt = subtitlesByPath[subPath];
      if (rawVtt === undefined) {
        continue;
      }

      const clipCues = parseWebVtt(rawVtt);
      let langList = cuesByLang.get(lang);
      if (!langList) {
        langList = [];
        cuesByLang.set(lang, langList);
      }

      for (const cue of clipCues) {
        if (cue.endMs <= trimStartMs || cue.startMs >= trimEndMs) {
          continue;
        }
        const clampedStart = Math.max(cue.startMs, trimStartMs);
        const clampedEnd = Math.min(cue.endMs, trimEndMs);
        if (clampedEnd <= clampedStart) {
          continue;
        }
        langList.push({
          startMs: clampedStart + shiftMs,
          endMs: clampedEnd + shiftMs,
          text: cue.text,
        });
      }
    }
  }

  const mergedSubtitlesPaths: Record<string, string> = {};
  const mergedSubtitlesVtt: Record<string, string> = {};

  for (const [lang, cues] of cuesByLang.entries()) {
    if (!isValidSubtitleLang(lang)) {
      continue;
    }
    const outPath = `subtitles/${lang}/timeline.vtt`;
    mergedSubtitlesPaths[lang] = outPath;
    mergedSubtitlesVtt[outPath] = serializeWebVtt(cues);
  }

  return { mergedSubtitlesPaths, mergedSubtitlesVtt };
}

/**
 * Returns the active subtitle text at `timeMs` (or null if none active).
 */
export function findActiveSubtitleText(cues: readonly WebVttCue[], timeMs: number): string | null {
  const active: string[] = [];
  for (const cue of cues) {
    if (timeMs >= cue.startMs && timeMs < cue.endMs) {
      active.push(cue.text);
    }
  }
  return active.length > 0 ? active.join("\n") : null;
}
