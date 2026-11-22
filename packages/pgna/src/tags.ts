import type {
  AnnotationColor,
  ArrowAnnotation,
  BoardOrientation,
  GuessOutcome,
  GuessReturnPolicy,
  NodeId,
  ParsedAtTag,
  ParsedCueDirective,
  ParsedCueTag,
  ParsedNodeTags,
  PgnaDiagnostic,
  SquareHighlight,
} from "./types.js";
import { isValidClipId } from "./validator.js";

const ARROW_PATTERN = /^([GRYB])([a-h][1-8])([a-h][1-8])$/;
const SQUARE_PATTERN = /^([GRYB])([a-h][1-8])$/;
const ORDINAL_PATTERN = /^#(\d+(?:\.\d+)?)$/;
const DECIMAL_SECONDS_PATTERN = /^\d+(?:\.\d+)?$/;
const MM_SS_PATTERN = /^(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/;
const HH_MM_SS_PATTERN = /^(\d+):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/;

/**
 * Strictly parses PGNA time strings:
 * - Non-negative decimal seconds (`12`, `45.25`) — rejects signs, hex, scientific notation
 * - `MM:SS(.mmm)`
 * - `HH:MM:SS(.mmm)`
 */
export function parsePgnaTimeMs(raw: string): number | null {
  const token = raw.trim();
  if (!token) return null;

  if (DECIMAL_SECONDS_PATTERN.test(token)) {
    const seconds = Number(token);
    if (!Number.isFinite(seconds)) return null;
    const ms = Math.round(seconds * 1000);
    return Number.isFinite(ms) && Number.isSafeInteger(ms) ? ms : null;
  }

  const hms = HH_MM_SS_PATTERN.exec(token);
  if (hms) {
    const hours = Number(hms[1]);
    const mins = Number(hms[2]);
    const secs = Number(hms[3]);
    const msStr = hms[4] ? hms[4].padEnd(3, "0") : "0";
    const frac = Number(msStr);
    const ms = ((hours * 60 + mins) * 60 + secs) * 1000 + frac;
    return Number.isFinite(ms) && Number.isSafeInteger(ms) ? ms : null;
  }

  const msMatch = MM_SS_PATTERN.exec(token);
  if (msMatch) {
    const mins = Number(msMatch[1]);
    const secs = Number(msMatch[2]);
    const fracStr = msMatch[3] ? msMatch[3].padEnd(3, "0") : "0";
    const frac = Number(fracStr);
    const ms = (mins * 60 + secs) * 1000 + frac;
    return Number.isFinite(ms) && Number.isSafeInteger(ms) ? ms : null;
  }

  return null;
}

export function formatPgnaSeconds(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  if (safe % 1000 === 0) {
    return String(safe / 1000);
  }
  return (safe / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

export function parseArrowList(raw: string): ArrowAnnotation[] | null {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const items = trimmed.split(",");
  const result: ArrowAnnotation[] = [];
  for (const item of items) {
    const match = ARROW_PATTERN.exec(item.trim());
    if (!match) return null;
    result.push({
      color: match[1] as AnnotationColor,
      from: match[2]!,
      to: match[3]!,
    });
  }
  return result;
}

export function parseSquareList(raw: string): SquareHighlight[] | null {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const items = trimmed.split(",");
  const result: SquareHighlight[] = [];
  for (const item of items) {
    const match = SQUARE_PATTERN.exec(item.trim());
    if (!match) return null;
    result.push({
      color: match[1] as AnnotationColor,
      square: match[2]!,
    });
  }
  return result;
}

function formatArrow(a: ArrowAnnotation): string {
  return `${a.color}${a.from}${a.to}`;
}

function formatHighlight(h: SquareHighlight): string {
  return `${h.color}${h.square}`;
}

function arrowKey(a: ArrowAnnotation): string {
  return `${a.color}:${a.from}:${a.to}`;
}

function highlightKey(h: SquareHighlight): string {
  return `${h.color}:${h.square}`;
}

function dedupeArrows(arrows: readonly ArrowAnnotation[]): ArrowAnnotation[] {
  const seen = new Set<string>();
  const out: ArrowAnnotation[] = [];
  for (const a of arrows) {
    const key = arrowKey(a);
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ color: a.color, from: a.from, to: a.to });
    }
  }
  return out;
}

function dedupeHighlights(highlights: readonly SquareHighlight[]): SquareHighlight[] {
  const seen = new Set<string>();
  const out: SquareHighlight[] = [];
  for (const h of highlights) {
    const key = highlightKey(h);
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ color: h.color, square: h.square });
    }
  }
  return out;
}

/**
 * Applies a single `[%cue]`'s directives in PGNA §4.2 deterministic canonical order:
 * `clear` -> `cal`/`csl` -> `+cal`/`+csl` -> `-cal`/`-csl`.
 */
export function applyCueDirectives(
  state: { arrows: ArrowAnnotation[]; highlights: SquareHighlight[] },
  directives: readonly ParsedCueDirective[],
): { arrows: ArrowAnnotation[]; highlights: SquareHighlight[] } {
  let arrows = state.arrows.map((a) => ({ ...a }));
  let highlights = state.highlights.map((h) => ({ ...h }));

  // 1. clear
  for (const d of directives) {
    if (d.kind === "clear") {
      arrows = [];
      highlights = [];
    }
  }

  // 2. cal / csl (replace)
  for (const d of directives) {
    if (d.kind === "cal" && d.arrows) {
      arrows = dedupeArrows(d.arrows);
    } else if (d.kind === "csl" && d.highlights) {
      highlights = dedupeHighlights(d.highlights);
    }
  }

  // 3. +cal / +csl (add)
  for (const d of directives) {
    if (d.kind === "+cal" && d.arrows) {
      arrows = dedupeArrows([...arrows, ...d.arrows]);
    } else if (d.kind === "+csl" && d.highlights) {
      highlights = dedupeHighlights([...highlights, ...d.highlights]);
    }
  }

  // 4. -cal / -csl (remove)
  for (const d of directives) {
    if (d.kind === "-cal" && d.arrows) {
      const toRemove = new Set(d.arrows.map(arrowKey));
      arrows = arrows.filter((a) => !toRemove.has(arrowKey(a)));
    } else if (d.kind === "-csl" && d.highlights) {
      const toRemove = new Set(d.highlights.map(highlightKey));
      highlights = highlights.filter((h) => !toRemove.has(highlightKey(h)));
    }
  }

  return { arrows, highlights };
}

function parseCueTagBody(
  body: string,
  nodeId: NodeId | undefined,
  diagnostics: PgnaDiagnostic[],
): ParsedCueTag | null {
  const parts = body.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) {
    diagnostics.push({
      code: "INVALID_CUE_TAG",
      severity: "error",
      nodeId,
      message: `Invalid [%cue] tag "${body}": expected offset and at least one directive.`,
    });
    return null;
  }

  const offsetMs = parsePgnaTimeMs(parts[0]!);
  if (offsetMs === null) {
    diagnostics.push({
      code: "INVALID_CUE_TAG",
      severity: "error",
      nodeId,
      message: `Invalid [%cue] offset "${parts[0]}".`,
    });
    return null;
  }

  const directives: ParsedCueDirective[] = [];
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i]!;
    if (token === "clear") {
      directives.push({ kind: "clear" });
      continue;
    }

    const eqIdx = token.indexOf("=");
    if (eqIdx === -1) {
      diagnostics.push({
        code: "INVALID_CUE_TAG",
        severity: "error",
        nodeId,
        message: `Unknown [%cue] directive "${token}".`,
      });
      return null;
    }

    const key = token.slice(0, eqIdx);
    const val = token.slice(eqIdx + 1);

    if (key === "cal" || key === "+cal" || key === "-cal") {
      const arrows = parseArrowList(val);
      if (arrows === null) {
        diagnostics.push({
          code: "INVALID_CUE_TAG",
          severity: "error",
          nodeId,
          message: `Invalid arrow list in [%cue] directive "${token}".`,
        });
        return null;
      }
      directives.push({ kind: key, arrows });
    } else if (key === "csl" || key === "+csl" || key === "-csl") {
      const highlights = parseSquareList(val);
      if (highlights === null) {
        diagnostics.push({
          code: "INVALID_CUE_TAG",
          severity: "error",
          nodeId,
          message: `Invalid square list in [%cue] directive "${token}".`,
        });
        return null;
      }
      directives.push({ kind: key, highlights });
    } else {
      diagnostics.push({
        code: "INVALID_CUE_TAG",
        severity: "error",
        nodeId,
        message: `Unsupported [%cue] directive "${token}".`,
      });
      return null;
    }
  }

  return { offsetMs, directives };
}

function parseAtTagBody(
  body: string,
  nodeId: NodeId | undefined,
  diagnostics: PgnaDiagnostic[],
): ParsedAtTag | null {
  const parts = body.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) {
    diagnostics.push({
      code: "INVALID_AT_TAG",
      severity: "error",
      nodeId,
      message: `Invalid [%at] tag "${body}".`,
    });
    return null;
  }

  const rawSpec = parts[0]!;
  let mode: "ordinal" | "timestamp";
  let value: number;

  const ordMatch = ORDINAL_PATTERN.exec(rawSpec);
  if (ordMatch?.[1]) {
    const parsedOrd = Number(ordMatch[1]);
    if (!Number.isFinite(parsedOrd)) {
      diagnostics.push({
        code: "INVALID_AT_TAG",
        severity: "error",
        nodeId,
        message: `Invalid [%at] ordinal "${rawSpec}".`,
      });
      return null;
    }
    mode = "ordinal";
    value = parsedOrd;
  } else {
    const timeMs = parsePgnaTimeMs(rawSpec);
    if (timeMs === null) {
      diagnostics.push({
        code: "INVALID_AT_TAG",
        severity: "error",
        nodeId,
        message: `Invalid [%at] timestamp/ordinal "${rawSpec}".`,
      });
      return null;
    }
    mode = "timestamp";
    value = timeMs;
  }

  let durMs: number | undefined;
  if (parts.length === 2) {
    const opt = parts[1]!;
    if (!opt.startsWith("dur=")) {
      diagnostics.push({
        code: "INVALID_AT_TAG",
        severity: "error",
        nodeId,
        message: `Invalid [%at] option "${opt}": expected dur=<time>.`,
      });
      return null;
    }
    const parsedDur = parsePgnaTimeMs(opt.slice(4));
    if (parsedDur === null) {
      diagnostics.push({
        code: "INVALID_AT_TAG",
        severity: "error",
        nodeId,
        message: `Invalid [%at] duration value "${opt}".`,
      });
      return null;
    }
    durMs = parsedDur;
  }

  return {
    mode,
    value,
    ...(durMs !== undefined ? { durMs } : {}),
    rawSpec,
  };
}

const KNOWN_PGNA_TAGS = new Set([
  "cal",
  "csl",
  "audio",
  "at",
  "dur",
  "orient",
  "guess",
  "outcome",
  "cue",
]);

/**
 * Parses all brace comment blocks attached to a single PGN node into structured PGNA tags,
 * cleaned prose text, preserved third-party tags (`[%clk]`, `[%eval]`, etc.), and diagnostics.
 */
export function parseNodeComments(
  comments: readonly string[],
  nodeId?: NodeId,
): { tags: ParsedNodeTags; diagnostics: PgnaDiagnostic[] } {
  const diagnostics: PgnaDiagnostic[] = [];
  const proseParts: string[] = [];
  const preservedTags: string[] = [];
  let arrows: ArrowAnnotation[] = [];
  let highlights: SquareHighlight[] = [];
  let audioClipId: string | null = null;
  let audioTagCount = 0;
  const atTags: ParsedAtTag[] = [];
  let durMs: number | null = null;
  let orientation: BoardOrientation | null = null;
  let guess: { returnPolicy: GuessReturnPolicy } | null = null;
  let outcome: GuessOutcome | null = null;
  const cues: ParsedCueTag[] = [];

  const tagRegex = /\[%([A-Za-z][A-Za-z0-9_-]*)(?:\s+([^\]]*))?\]/g;

  for (const comment of comments) {
    const proseWithoutTags = comment
      .replace(tagRegex, (fullMatch, rawName: string, rawBody: string | undefined) => {
        const name = rawName.toLowerCase();
        const body = (rawBody ?? "").trim();

        if (!KNOWN_PGNA_TAGS.has(name)) {
          preservedTags.push(fullMatch);
          return " ";
        }

        switch (name) {
          case "cal": {
            if (body === "") {
              diagnostics.push({
                code: "INVALID_CAL_TAG",
                severity: "warning",
                nodeId,
                message: "Empty [%cal] arrow annotation ignored.",
              });
              break;
            }
            const parsed = parseArrowList(body);
            if (parsed === null) {
              diagnostics.push({
                code: "INVALID_CAL_TAG",
                severity: "warning",
                nodeId,
                message: `Malformed [%cal ${body}] arrow annotation ignored.`,
              });
            } else {
              arrows = dedupeArrows([...arrows, ...parsed]);
            }
            break;
          }
          case "csl": {
            if (body === "") {
              diagnostics.push({
                code: "INVALID_CSL_TAG",
                severity: "warning",
                nodeId,
                message: "Empty [%csl] square highlight ignored.",
              });
              break;
            }
            const parsed = parseSquareList(body);
            if (parsed === null) {
              diagnostics.push({
                code: "INVALID_CSL_TAG",
                severity: "warning",
                nodeId,
                message: `Malformed [%csl ${body}] square highlight ignored.`,
              });
            } else {
              highlights = dedupeHighlights([...highlights, ...parsed]);
            }
            break;
          }
          case "audio": {
            audioTagCount++;
            if (audioTagCount > 1) {
              diagnostics.push({
                code: "DUPLICATE_AUDIO_TAG",
                severity: "error",
                nodeId,
                message: `Node ${nodeId ?? "<unknown>"} has multiple [%audio] tags; at most one audio clip is allowed per node.`,
              });
            } else if (!isValidClipId(body)) {
              diagnostics.push({
                code: "INVALID_CLIP_ID",
                severity: "error",
                nodeId,
                message: `Invalid [%audio] clipId "${body}".`,
              });
            } else {
              audioClipId = body;
            }
            break;
          }
          case "at": {
            const parsedAt = parseAtTagBody(body, nodeId, diagnostics);
            if (parsedAt) {
              atTags.push(parsedAt);
            }
            break;
          }
          case "dur": {
            const parsedDur = parsePgnaTimeMs(body);
            if (parsedDur === null) {
              diagnostics.push({
                code: "INVALID_DUR_TAG",
                severity: "error",
                nodeId,
                message: `Invalid [%dur] value "${body}".`,
              });
            } else {
              durMs = parsedDur;
            }
            break;
          }
          case "orient": {
            const lower = body.toLowerCase();
            if (lower === "white" || lower === "black") {
              orientation = lower;
            } else {
              diagnostics.push({
                code: "INVALID_ORIENT_TAG",
                severity: "error",
                nodeId,
                message: `Invalid [%orient] value "${body}": expected "white" or "black".`,
              });
            }
            break;
          }
          case "guess": {
            if (body === "") {
              guess = { returnPolicy: "manual" };
            } else {
              const lower = body.toLowerCase();
              if (lower === "return=manual") {
                guess = { returnPolicy: "manual" };
              } else if (lower === "return=auto") {
                guess = { returnPolicy: "auto" };
              } else {
                diagnostics.push({
                  code: "INVALID_GUESS_TAG",
                  severity: "error",
                  nodeId,
                  message: `Invalid [%guess] parameter "${body}": expected return=auto or return=manual.`,
                });
              }
            }
            break;
          }
          case "outcome": {
            const lower = body.toLowerCase();
            if (
              lower === "success" ||
              lower === "interesting" ||
              lower === "dubious" ||
              lower === "fail"
            ) {
              outcome = lower;
            } else {
              diagnostics.push({
                code: "INVALID_OUTCOME_TAG",
                severity: "error",
                nodeId,
                message: `Invalid [%outcome] value "${body}".`,
              });
            }
            break;
          }
          case "cue": {
            const parsedCue = parseCueTagBody(body, nodeId, diagnostics);
            if (parsedCue) {
              cues.push(parsedCue);
            }
            break;
          }
        }

        return " ";
      })
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();

    if (proseWithoutTags.length > 0) {
      proseParts.push(proseWithoutTags);
    }
  }

  return {
    tags: {
      prose: proseParts.join(" ").trim(),
      preservedTags,
      arrows,
      highlights,
      audioClipId,
      atTags,
      durMs,
      orientation,
      guess,
      outcome,
      cues,
    },
    diagnostics,
  };
}

/**
 * Serializes structured PGNA node tags + prose + preserved third-party tags into a single
 * canonical PGN brace comment body (empty string if nothing to emit).
 */
export function formatNodeComment(tags: ParsedNodeTags): string {
  const tokens: string[] = [];

  const sanitizedProse = tags.prose.replace(/[{}]/g, "").trim();
  if (sanitizedProse.length > 0) {
    tokens.push(sanitizedProse);
  }

  for (const preserved of tags.preservedTags) {
    tokens.push(preserved);
  }

  if (tags.arrows.length > 0) {
    tokens.push(`[%cal ${tags.arrows.map(formatArrow).join(",")}]`);
  }

  if (tags.highlights.length > 0) {
    tokens.push(`[%csl ${tags.highlights.map(formatHighlight).join(",")}]`);
  }

  if (tags.orientation) {
    tokens.push(`[%orient ${tags.orientation}]`);
  }

  if (tags.audioClipId) {
    tokens.push(`[%audio ${tags.audioClipId}]`);
  }

  for (const at of tags.atTags) {
    const spec =
      at.mode === "ordinal" ? `#${at.value}` : formatPgnaSeconds(at.value);
    const durSuffix = at.durMs !== undefined ? ` dur=${formatPgnaSeconds(at.durMs)}` : "";
    tokens.push(`[%at ${spec}${durSuffix}]`);
  }

  if (tags.durMs !== null) {
    tokens.push(`[%dur ${formatPgnaSeconds(tags.durMs)}]`);
  }

  if (tags.guess) {
    tokens.push(
      tags.guess.returnPolicy === "auto" ? "[%guess return=auto]" : "[%guess]",
    );
  }

  if (tags.outcome) {
    tokens.push(`[%outcome ${tags.outcome}]`);
  }

  const sortedCues = [...tags.cues].sort((a, b) => a.offsetMs - b.offsetMs);
  for (const cue of sortedCues) {
    const dirStrings = cue.directives.map((d) => {
      if (d.kind === "clear") return "clear";
      if (d.kind === "cal" || d.kind === "+cal" || d.kind === "-cal") {
        return `${d.kind}=${(d.arrows ?? []).map(formatArrow).join(",")}`;
      }
      return `${d.kind}=${(d.highlights ?? []).map(formatHighlight).join(",")}`;
    });
    if (dirStrings.length > 0) {
      tokens.push(`[%cue ${formatPgnaSeconds(cue.offsetMs)} ${dirStrings.join(" ")}]`);
    }
  }

  return tokens.join(" ").trim();
}
