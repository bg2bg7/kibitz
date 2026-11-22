# PGNA (PGN-Audio) File Format Specification — v1.0

**Extension**: `.pgna`  
**MIME Type**: `application/vnd.pgn-audio+zip`  
**Version**: `1.0`

---

## 1. Overview & Design Goals

**PGNA** (`.pgna`) is a portable, client-agnostic container format that binds multi-game **Lichess-extended PGN** with **per-move audio narration**, **optional WebVTT subtitles**, **sub-move timestamped board annotations**, and a **compiled linear auto-play timeline**.

Core principles:

1. **Client-agnostic rendering**: The format encodes board state (`FEN`), last-move coordinates, Lichess arrows/highlights, audio clips, and subtitles — leaving all visual presentation (2D SVG, 3D, canvas, terminal, etc.) entirely up to the client.
2. **Standard PGN compatibility**: The embedded PGN uses valid standard-chess PGN with `[%tag value]` comment commands (including Lichess `[%cal]` and `[%csl]`). Any normal chess client can open `study.pgn` directly and ignore PGNA tags cleanly.
3. **One audio file per move (easy redubbing)**: Each narrated node references at most one audio clip declared in `manifest.json#clips` (recommended path `audio/<clipId>.<ext>`), enabling editors to re-record, swap, or non-destructively trim individual moves without opening an external DAW or re-encoding the entire stream.
4. **Non-linear authoring, linear playback**: Timestamps in `study.pgn` may appear out of order across games, positions (`[FEN]`), and variations (RAVs). Compilation produces a deterministic, strictly ordered linear index (`timeline.json`) for auto-play.
5. **Dual playback modes**: Clients can auto-play along `timeline.json` **or** ignore the timeline completely and let the user step through `study.pgn` like a normal chess viewer while optionally playing any move's attached audio clip and subtitles.

---

## 2. Container Structure

A `.pgna` file is a standard **ZIP archive** (PKWARE ZIP, UTF-8 filenames).

| Entry Path | Required | ZIP Compression | Description |
| :--- | :---: | :---: | :--- |
| `manifest.json` | Yes | `DEFLATE` | Format metadata, timing policy, clip registry, subtitle map |
| `<manifest.pgnPath>` (default `study.pgn`) | Yes | `DEFLATE` | UTF-8 multi-game Lichess-extended PGN with PGNA tags |
| `<manifest.timelinePath>` (default `timeline.json`) | Yes | `DEFLATE` | Compiled linear auto-play index, `nodeIndex`, and compiled `guesses` |
| `<clip.path>` (recommended `audio/<clipId>.<ext>`) | Conditional | **`STORE` (method `0`)** | Per-move audio files referenced by `manifest.json#clips`. **MUST** use ZIP compression method `0` (`STORE`, uncompressed) for fast seeking and zero-overhead streaming. Validators verify this method on read. |
| `<clip.subtitles[lang]>` (recommended `subtitles/<lang>/<clipId>.vtt`) | No | `DEFLATE` | Per-clip WebVTT subtitle tracks (timestamps relative to `00:00.000` of that clip) |
| `subtitles/<lang>/timeline.vtt` | No | `DEFLATE` | Compiler-generated global WebVTT track aligned to `timeline.json` |

### 2.1 Archive Path Safety
All ZIP entry paths and all path strings in `manifest.json` (`pgnPath`, `timelinePath`, `clips[id].path`, `clips[id].subtitles[lang]`) **MUST** be safe archive-relative POSIX paths:
- Non-empty, using `/` as the sole separator (no `\`, no NUL bytes, no Windows drive prefixes such as `C:`).
- Must **NOT** start with `/`.
- Must **NOT** contain `.` or `..` path segments or empty segments (`//`).

Unpackers and validators **MUST** reject archives containing unsafe paths. Readers **SHOULD** ignore extraneous OS archive metadata entries (such as `__MACOSX/...` or `.DS_Store`) when scanning unreferenced files.

### 2.2 Versioning & Extensibility
- `manifest.version` and `timeline.version` identify the format version (`"1.0"`).
- Conformant readers **MUST** ignore unrecognized JSON properties in `manifest.json` and `timeline.json` so forward-compatible additive fields do not break older clients.
- Future minor revisions (`1.x`) will remain backward-compatible with v1.0 readers; breaking changes require a major version increment (`2.0`).

---

## 3. Canonical Node Addressing (`NodeId`) & Chess Scope

PGNA v1.0 targets standard chess (`[Variant "Standard"]` or omitted `[Variant]` header).

Every board state in `study.pgn` has a deterministic, canonical `NodeId`:

- `g<gameIndex>` — The starting position (before move 1) of 0-indexed game `<gameIndex>` (standard initial position, or `[FEN "..."]` when present).
- `g<gameIndex>/<c0>.<c1>...` — A sequence of 0-indexed child indices descending from the game root:
  - Child `0` is always the mainline continuation from the parent position.
  - Children `1, 2, ...` are Recursive Annotation Variations (RAVs) branching as alternatives to child `0` from the same parent position.

> **Positional stability**: `NodeId`s are positional addresses derived from the tree structure of a specific `study.pgn`. Promoting a variation or inserting/reordering sibling RAVs renumbers affected `NodeId`s; external tools storing bookmarks or references should treat `NodeId`s as valid for a specific PGN revision.

### Example

```pgn
1. e4 e5 (1... c5 2. Nf3) 2. Nf3
```

| Position / Move | `NodeId` | `ply` |
| :--- | :--- | :---: |
| Initial position | `g0` | `0` |
| `1. e4` | `g0/0` | `1` |
| `1... e5` | `g0/0.0` | `2` |
| `1... c5` (variation) | `g0/0.1` | `2` |
| `2. Nf3` (inside variation) | `g0/0.1.0` | `3` |
| `2. Nf3` (mainline) | `g0/0.0.0` | `3` |

- `ply` is always `0` at a game's root node (`g<gameIndex>`) and increments by `1` per half-move descending from the root (including `[FEN]` games).
- Note: In PGN grammar, a RAV `( ... )` appearing immediately after move `M` specifies an alternative to `M` (so its first move is a sibling of `M`, attached to `M`'s parent). A RAV appearing before any move in a sequence is malformed and ignored.

---

## 4. Extended PGN Tag Grammar

All PGNA tags are placed inside standard PGN `{ ... }` brace comments using `[%tag value]` syntax. Existing prose comments and Lichess tags (`[%cal]`, `[%csl]`, `[%clk]`, `[%eval]`, etc.) are preserved.

> **Root-node & variation-start comments**:
> - A PGN brace comment appearing before move 1 of game `i` (e.g., `{ Study intro... } 1. e4 ...`) attaches to the game's root node `g<i>` (the initial / `[FEN]` position), **not** to `g<i>/0`.
> - A PGN brace comment appearing immediately after `(` before the first move of a RAV (e.g., `1. e4 ({ Alternative plan } 1. d4)`) attaches to that variation's **first move** (`1. d4`), **not** to the parent position.

### 4.1 Lichess Headers & Board Decoration Tags

- **`[Orientation "white" | "black"]`** *(PGN Header)* — Optional Lichess-standard game-level board perspective (case-insensitive exact tokens `white` or `black`; defaults to `"white"`).
- **`[%cal <arrow>(,<arrow>)*]`** — Colored arrows (move default at `t = 0`). Each arrow matches `[GRYB][a-h][1-8][a-h][1-8]` (`G`=Green, `R`=Red, `Y`=Yellow, `B`=Blue; uppercase color letter).
- **`[%csl <square>(,<square>)*]`** — Colored square highlights (move default at `t = 0`). Each square matches `[GRYB][a-h][1-8]` (uppercase color letter).

### 4.2 PGNA Audio, Perspective & Timeline Tags

#### `[%audio <clipId>]`
Attaches a single audio clip (declared in `manifest.json#clips`) to this node.
- `<clipId>` **MUST** match `^[A-Za-z0-9_-]+$` and **MUST NOT** be the reserved identifier `"timeline"` (reserved for compiler-generated `subtitles/<lang>/timeline.vtt`).
- A node **MUST NOT** have more than one `[%audio]` tag (even across multiple `{ ... }` comment blocks on the same node); duplicates are a compiler error (`DUPLICATE_AUDIO_TAG`).
- Example: `[%audio clip-001]`

#### `[%at <spec> [dur=<time>]]`
Places this node on the compiled auto-play timeline. A node **MAY** have multiple `[%at]` tags (across one or more `{ ... }` comment blocks) so the timeline can return to a previously visited position — for example, returning to the main line after walking through a variation. However, a node still **MUST NOT** have more than one `[%audio]` tag (`DUPLICATE_AUDIO_TAG`), and revisiting a node **never** plays audio a second time.

`<spec>` is either:
- **Explicit timestamp**: `HH:MM:SS(.mmm)`, `MM:SS(.mmm)`, or non-negative decimal seconds (`45.25`, `12`; strict decimal digits — no signs, hex, or scientific notation).
- **Sequence ordinal**: `#<number>` where `<number>` is a non-negative decimal number (`^\d+(?:\.\d+)?$`, e.g., `#1`, `#2`, `#10`, `#2.5`), allowing easy clip reordering and automatic timestamp reflow when clips are redubbed or trimmed.

Optional per-tag duration override:
- `dur=<time>` (non-negative decimal seconds or `MM:SS(.mmm)`) overrides the display/pause duration for that specific timeline occurrence (for example, `[%at #4 dur=1.2]`).

Ordering, primary vs. revisit, & mode rules during compilation:
1. All `[%at]` occurrences across all games and variations (plus nodes with `[%audio]` and no `[%at]` if `manifest.compilation.includeUnscheduledAudio` is `true`) are collected.
2. **Single scheduling mode per study**: A study **MUST** use either sequence ordinals (`#N`) **or** explicit timestamps consistently across all `[%at]` tags. Mixing `#` ordinals and explicit timestamps in the same study is a compiler error (`MIXED_TIMELINE_MODES`).
3. Ties in `[%at]` value are broken deterministically by **PGN document order** (the order in which nodes appear in `study.pgn` text, across games and inline RAVs), and then by tag order on the same node.
4. **Primary visit vs. silent revisit**:
   - The **earliest** timeline occurrence of a `nodeId` is its **primary visit** (`isRevisit` omitted). It plays the node's attached `[%audio]` clip (if any), sub-move `[%cue]` snapshots, subtitles, and `[%guess]` prompt.
   - Every **subsequent** timeline occurrence of the same `nodeId` is a **silent revisit** (`isRevisit: true`). Its `audio` is **ALWAYS `null`** (never replays or attaches a second audio clip), it emits no subtitles, it does not re-trigger `[%guess]`, and its `cues` array contains only the single baseline `offsetMs: 0` snapshot of the node's `[%cal]`/`[%csl]` decorations.
   - A revisit's pause duration resolves as: the occurrence's `dur=<time>` override if present, otherwise `manifest.compilation.defaultReturnPauseMs` (default `1000` ms).
5. A node with `[%audio <clipId>]` and **no** `[%at]` tag is still playable in **Manual Mode**, and is omitted from the auto-play timeline unless `manifest.compilation.includeUnscheduledAudio` is `true` (in which case it is appended in PGN document order).

#### `[%dur <seconds>]`
Optional display/delay duration (non-negative decimal seconds or `MM:SS(.mmm)`) for a **no-audio (silent) node** placed on the timeline (a node with `[%at]` and no `[%audio]`).
- On a primary silent visit, duration resolves as: the `[%at]` tag's `dur=<time>` (if present) → `[%dur]` (if present) → `manifest.compilation.defaultSilentDurationMs` (default `1500` ms).
- The resolved duration of any timeline entry (primary, revisit, or branch step) **MUST** be strictly greater than `0` ms (`ZERO_ENTRY_DURATION` error otherwise).
- If `[%dur]` or `dur=<time>` is placed on a primary visit that also has `[%audio]`, the audio clip's trimmed duration takes precedence and the compiler emits an `IGNORED_DUR_TAG` warning. (A `dur=<time>` on a subsequent revisit `[%at]` tag of an audio node is honored and does **not** emit `IGNORED_DUR_TAG`.)

#### `[%orient white|black]`
Optional per-node board orientation override (case-insensitive exact tokens `white` or `black`). When omitted, the node inherits its game's `[Orientation "..."]` header (default `"white"`).

#### `[%guess]` / `[%guess return=auto|manual]`
Marks this node as an **interactive move prompt**. When auto-play reaches the end of this node (`entry.endMs`), conformant interactive clients pause playback and await a legal chess move from the user.
- `return=manual` (default): After auto-playing through a secondary variation's `branchTimeline`, pause at the end of the variation and present a **Return to Guess** action.
- `return=auto`: Automatically return to the `[%guess]` prompt position after a non-`success` variation finishes playing.

#### `[%outcome <success|interesting|dubious|fail>]`
Optional explicit override placed on an immediate child move of a `[%guess]` node (case-insensitive exact tokens `success`, `interesting`, `dubious`, or `fail`).

**Branch Outcome Classification Priority** (applied identically to both the mainline child `children[0]` and variation siblings `children[1..k]`):
1. Explicit `[%outcome ...]` tag on the child move.
2. Standard PGN NAG assessment on the child move:
   - `!` (`$1`) or `!!` (`$3`) → `success`
   - `!?` (`$5`) → `interesting`
   - `?!` (`$6`) → `dubious`
   - `?` (`$2`) or `??` (`$4`) → `fail`
3. Fallback default: mainline child (`children[0]`) → `success`; untagged variation (`children[1..k]`) → `fail`.

Because NAG classification applies equally to the mainline and variations, a real game where the mainline move was a mistake (e.g., `14. Bb5??`) resolves as `fail`, while a missed win in a variation (e.g., `(14. Nd5! ...)`) resolves as `success`.

Legal moves not present as any child of the prompt node are treated as `unlisted` wrong guesses; the player remains on the prompt position ready for another attempt.

#### `[%cue <offset> <directive>...]`
Schedules a sub-move board annotation update at `<offset>` (decimal seconds or `MM:SS(.mmm)`) relative to the **un-trimmed `00:00.000`** of this node's attached audio clip — matching per-clip WebVTT `.vtt` timestamps so non-destructive trimming never desynchronizes arrows or subtitles. (For silent nodes without audio, `<offset>` is relative to entry start `00:00.000`.) Multiple `[%cue]` tags may appear in the same comment in any order; the compiler sorts them stably by `offsetMs`.

Trimming & compilation semantics for `[%cue]`:
- Cues with `offsetMs <= trimStartMs` are folded chronologically into the resolved `offsetMs: 0` baseline snapshot (so arrows drawn before the trim-in point remain visible when playback begins).
- Cues with `trimStartMs < offsetMs < trimEndMs` emit compiled snapshots at `offsetMs = rawOffsetMs - trimStartMs` (`globalTimeMs = entry.startMs + offsetMs`).
- Cues with `offsetMs >= trimEndMs` (and `offsetMs > trimStartMs`) emit a `CUE_OUT_OF_BOUNDS` warning and are omitted so no cue lands on `entry.endMs`.

Supported directives (space-separated after `<offset>`), evaluated in deterministic canonical order within a single `[%cue]` (`clear` → `cal`/`csl` → `+cal`/`+csl` → `-cal`/`-csl`):
- `clear` — Clear all arrows and square highlights
- `cal=<arrows>` — Replace all arrows (`cal=` with empty value clears arrows)
- `csl=<squares>` — Replace all square highlights (`csl=` with empty value clears highlights)
- `+cal=<arrows>` / `-cal=<arrows>` — Add or remove specific arrows from the current state
- `+csl=<squares>` / `-csl=<squares>` — Add or remove specific square highlights

Examples:
```pgn
1. e4 { Control the center. [%cal Ge2e4] [%audio clip-001] [%at #1]
  [%cue 1.800 +cal=Gd2d4 csl=Ge4,Gd4]
  [%cue 4.500 clear] }
```

---

## 5. `manifest.json` Schema

```json
{
  "format": "pgna",
  "version": "1.0",
  "pgnPath": "study.pgn",
  "timelinePath": "timeline.json",
  "title": "Italian Game Essentials",
  "author": "Coach Example",
  "description": "Key motifs across two illustrative games.",
  "createdAt": "2026-11-21T00:00:00.000Z",
  "updatedAt": "2026-11-21T00:00:00.000Z",
  "defaultSubtitleLang": "en",
  "compilation": {
    "timingMode": "flow",
    "defaultSilentDurationMs": 1500,
    "defaultReturnPauseMs": 1000,
    "defaultGapMs": 0,
    "includeUnscheduledAudio": false
  },
  "clips": {
    "clip-001": {
      "id": "clip-001",
      "path": "audio/clip-001.ogg",
      "mimeType": "audio/ogg; codecs=opus",
      "durationMs": 6200,
      "trimStartMs": 0,
      "trimEndMs": 6200,
      "label": "Intro on 1. e4",
      "subtitles": {
        "en": "subtitles/en/clip-001.vtt"
      }
    }
  }
}
```

### Compilation Options & Timing Modes (`compilation`)
- `timingMode`: `"flow"` (default) or `"strict"`. Any other value is a compiler error (`INVALID_COMPILATION_OPTIONS`).
  - **`flow`**: Entries are sorted by their `[%at]` key. For every entry `i > 0`, `startMs = max(declaredStartMs, previousEndMs + defaultGapMs)` (emitting a `TIMELINE_REFLOWED` warning when reflowed). For `#` ordinal and unscheduled entries, `startMs = 0` for `i = 0` and `previousEndMs + defaultGapMs` for `i > 0`.
  - **`strict`**: Entries with explicit timestamps are placed at their exact `declaredStartMs`; any overlap (`declaredStartMs < previousEndMs`) produces a `TIMELINE_OVERLAP` compiler error.
- `defaultSilentDurationMs`: Finite number **strictly `> 0`** (default `1500`). Default display/delay time for no-audio (silent) moves placed on the timeline (and silent steps inside `[%guess]` `branchTimeline`s) when no `[%dur]` or `dur=` override is specified.
- `defaultReturnPauseMs`: Finite number **strictly `> 0`** (default `1000`). Default silent pause duration when the timeline returns to a previously visited node (`isRevisit: true`) and no per-tag `dur=` override is specified on that revisit `[%at]` tag.
- `defaultGapMs`: Finite number **`>= 0`** (default `0`).
- `includeUnscheduledAudio`: Boolean (default `false`).

### Audio Clips & Supported Formats
- `clips[clipId].id` **MUST** equal `clipId`, match `^[A-Za-z0-9_-]+$`, and **MUST NOT** equal `"timeline"`.
- `durationMs` in `manifest.json` is the **authoritative** duration (`> 0`) used by the compiler. `trimStartMs` (default `0`) and `trimEndMs` (default `durationMs`) **MUST** satisfy `0 <= trimStartMs < trimEndMs <= durationMs`.
- Recommended format: **Opus** (`audio/ogg; codecs=opus`, `audio/webm; codecs=opus`).
- Also supported: **WAV** (`audio/wav`), **MP3** (`audio/mpeg`), **AAC/M4A** (`audio/mp4`). *(Note: CLI auto-probing inspects WAV, Ogg/Opus/Vorbis, and MPEG-1 Layer III MP3 headers natively; WebM/M4A clips should specify `durationMs` in `manifest.json` or be authored via browser Web Audio decoding.)*

---

## 6. `timeline.json` Schema (Compiled Linear Index)

`timeline.json` is deterministically derived from `manifest.json`, `study.pgn`, clip durations/trims, and subtitles. Clients SHOULD trust `timeline.json` for fast, zero-parse auto-play rendering; validators **MUST** re-compile and reject stale or divergent `timeline.json` files (ignoring `compiledAt`) with a `STALE_TIMELINE` error.

**Invariants**:
- Every entry has strictly positive duration (`endMs > startMs`).
- `entries` is strictly sorted by `startMs` ascending (`entries[i].startMs > entries[i - 1].startMs`) and non-overlapping (`entries[i].startMs >= entries[i - 1].endMs`).
- Every entry's `cues` array (both in `entries` and in every `branchTimeline` step) **MUST** begin with a baseline snapshot at `offsetMs: 0` (even when `arrows` and `highlights` are both empty `[]`), guaranteeing client binary-search logic always resolves a valid visual state.
- `nodeIndex[nodeId].timelineIndices` lists all main-timeline entry indices for that node in ascending timeline order (`[]` if unscheduled). `nodeIndex[nodeId].timelineIndex` is the primary (earliest) entry index (`timelineIndices[0] ?? null`).
- Silent return/revisit entries carry `isRevisit: true` and MUST have `audio: null`. Primary visits omit `isRevisit`.

### Compiled `[%guess]` Structures
When a study contains one or more `[%guess]` nodes:
- `timeline.guesses` maps each `promptNodeId` to its compiled `GuessSpec` (including prompts only reachable in Manual Mode).
- If a prompt node is also scheduled on the main timeline, its corresponding `TimelineEntry` includes `entry.guess` referencing the same `GuessSpec`.
- Each `GuessBranch` compiles a linear `branchTimeline` (starting at `0ms`, spaced by `defaultGapMs`) following `child` and its `children[0]` continuation:
  - Stops before any nested `[%guess]` descendant (for `stepIdx > 0`).
  - For the mainline child (`isMainline: true`), stops before any descendant with an explicit `[%at]` tag (avoiding duplicating moves already scheduled on the main timeline).
  - For variation children (`isMainline: false`), continues along `children[0]` until the variation ends or hits a nested `[%guess]`.
  - `mainTimelineIndex` is `nodeIndex[child.id].timelineIndex` (or `null` if the branch move is not scheduled on the main timeline).

### Example (Compiled from the §4.2 Example)

```json
{
  "format": "pgna-timeline",
  "version": "1.0",
  "compiledAt": "2026-11-21T00:00:00.000Z",
  "totalDurationMs": 6200,
  "games": [
    {
      "gameIndex": 0,
      "headers": { "Event": "Example Study", "White": "Player A", "Black": "Player B" },
      "initialFen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
      "orientation": "white"
    }
  ],
  "mergedSubtitles": {
    "en": "subtitles/en/timeline.vtt"
  },
  "entries": [
    {
      "index": 0,
      "startMs": 0,
      "endMs": 6200,
      "gameIndex": 0,
      "nodeId": "g0/0",
      "ply": 1,
      "san": "e4",
      "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      "lastMove": { "from": "e2", "to": "e4" },
      "orientation": "white",
      "comment": "Control the center.",
      "audio": {
        "clipId": "clip-001",
        "path": "audio/clip-001.ogg",
        "mimeType": "audio/ogg; codecs=opus",
        "durationMs": 6200,
        "trimStartMs": 0,
        "trimEndMs": 6200
      },
      "subtitles": {
        "en": "subtitles/en/clip-001.vtt"
      },
      "cues": [
        {
          "offsetMs": 0,
          "globalTimeMs": 0,
          "arrows": [{ "color": "G", "from": "e2", "to": "e4" }],
          "highlights": []
        },
        {
          "offsetMs": 1800,
          "globalTimeMs": 1800,
          "arrows": [
            { "color": "G", "from": "e2", "to": "e4" },
            { "color": "G", "from": "d2", "to": "d4" }
          ],
          "highlights": [
            { "color": "G", "square": "e4" },
            { "color": "G", "square": "d4" }
          ]
        },
        {
          "offsetMs": 4500,
          "globalTimeMs": 4500,
          "arrows": [],
          "highlights": []
        }
      ],
      "guess": {
        "promptNodeId": "g0/0",
        "returnPolicy": "manual",
        "branches": [
          {
            "nodeId": "g0/0.0",
            "san": "e5",
            "from": "e7",
            "to": "e5",
            "outcome": "success",
            "nags": ["$1"],
            "isMainline": true,
            "mainTimelineIndex": null,
            "branchTimeline": [],
            "branchDurationMs": 1500
          }
        ]
      }
    }
  ],
  "nodeIndex": {
    "g0/0": {
      "gameIndex": 0,
      "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1",
      "lastMove": { "from": "e2", "to": "e4" },
      "orientation": "white",
      "clipId": "clip-001",
      "subtitles": { "en": "subtitles/en/clip-001.vtt" },
      "timelineIndex": 0,
      "timelineIndices": [0]
    }
  },
  "guesses": {
    "g0/0": {
      "promptNodeId": "g0/0",
      "returnPolicy": "manual",
      "branches": []
    }
  }
}
```

*(Note: `entry.guess` and `timeline.guesses` are omitted when the study contains no `[%guess]` nodes; shown above for schema illustration.)*

---

## 7. Subtitles (WebVTT)

- Each clip may declare zero or more language tracks in `manifest.json#clips[id].subtitles` (BCP 47 language keys like `"en"`, `"es"`).
- Individual `.vtt` files use timestamps relative to the clip's un-trimmed `00:00.000`.
- When compiling `subtitles/<lang>/timeline.vtt`:
  - Silent entries (including silent revisits with `isRevisit: true`) emit no subtitle cues.
  - Cues completely outside `[trimStartMs, trimEndMs]` (`cue.endMs <= trimStartMs` or `cue.startMs >= trimEndMs`) are **dropped**.
  - Cues partially overlapping `[trimStartMs, trimEndMs]` are **clamped** to `[trimStartMs, trimEndMs]`.
  - Remaining cues are shifted by `entry.startMs - trimStartMs` into global timeline time.

---

## 8. Client Playback Contract

A conformant PGNA player MUST support:

### 8.1 Timeline Auto-Play Mode
- Binary-search `timeline.entries` by current `globalTimeMs`:
  - **Active entry** (`entry.startMs <= globalTimeMs < entry.endMs`): render `entry.fen`, `entry.lastMove`, `entry.orientation`, latest `cue` with `cue.offsetMs <= globalTimeMs - entry.startMs`, active subtitle cue, and play `entry.audio` from `trimStartMs + (globalTimeMs - entry.startMs)` stopping strictly at `trimEndMs`. For silent moves and silent revisit entries (`isRevisit: true`, where `entry.audio === null`), audio and subtitles **MUST** remain silent (`activeAudio: null`) while holding the position for the entry's duration (`defaultSilentDurationMs`, `defaultReturnPauseMs`, or explicit duration).
  - **Gap / pre-start / end** (`globalTimeMs < entries[0].startMs`, between `entries[i].endMs` and `entries[i + 1].startMs`, or `globalTimeMs >= totalDurationMs`): hold the preceding entry's final board/cue state (or `entries[0]`'s `offsetMs: 0` state before `entries[0].startMs`); audio and subtitles **MUST** be silent (`activeAudio: null`).

### 8.2 Manual Chess Mode
- Allow navigating the PGN move tree freely without enforcing `timeline.entries` order.
- When inspecting a node, clients MAY look up `nodeIndex[nodeId]` (or the parsed PGN node) to play that move's attached audio clip, sub-move `[%cue]` snapshots, and per-clip `.vtt` subtitles independently, or jump back into Timeline Mode at `nodeIndex[nodeId].timelineIndex` (or any entry in `nodeIndex[nodeId].timelineIndices`).

### 8.3 Interactive `[%guess]` Playback Contract
When interactive guesses are enabled:
1. **Triggering**: Whenever playback advances across `entry.endMs` for an unresolved timeline entry with `entry.guess` (having at least one branch), the player **MUST** clamp `globalTimeMs` to `entry.endMs`, pause playback, and enter the `awaiting` guess state on `promptNodeId` (even if a single clock tick spans multiple entries). Clients MAY also enter a prompt manually in Manual Mode via `timeline.guesses[nodeId]`.
2. **Evaluating moves**: Only legal chess moves from `promptFen` are accepted.
   - Moves matching no compiled branch resolve as `unlisted`; the player remains `awaiting` at `promptNodeId`.
   - **Mainline `success` scheduled on main timeline** (`outcome === 'success' && isMainline && mainTimelineIndex !== null`): mark the prompt resolved, exit the guess session, and seamlessly continue main-timeline playback from `entries[mainTimelineIndex].startMs`.
   - **All other matched branches** (variations of any outcome, or unscheduled mainline moves): play the branch's `branchTimeline` from `0` to `branchDurationMs`.
3. **Branch completion & return**:
   - When `branchTimeline` finishes, if `returnPolicy === 'auto'` and `branch.outcome !== 'success'`, automatically return to `awaiting` at `promptNodeId`.
   - Otherwise pause in `branch_complete`, allowing the user to **Return to Guess** (`awaiting` at `promptNodeId`), replay the branch, or **Continue** the main timeline from `entries[promptTimelineIndex + 1]`.
