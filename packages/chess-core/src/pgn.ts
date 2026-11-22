/**
 * Multi-game PGN AST parser and serializer preserving headers, root/move/variation-start
 * comments, NAGs (numeric and symbolic), and arbitrarily nested Recursive Annotation Variations (RAVs).
 *
 * Pure isomorphic module (zero DOM / React / Node-only dependencies).
 */

export interface PgnMoveNode {
  san: string;
  nags: string[];
  comments: string[];
  /** Mainline continuation is children[0]; RAV alternatives are children[1..k]. */
  children: PgnMoveNode[];
}

export type PgnResult = "1-0" | "0-1" | "1/2-1/2" | "*";

export interface PgnGameDocument {
  headers: Record<string, string>;
  rootComments: string[];
  /** Mainline first move is rootMoves[0]; alternative first moves are rootMoves[1..k]. */
  rootMoves: PgnMoveNode[];
  result: PgnResult;
}

type PgnToken =
  | { type: "header"; key: string; value: string }
  | { type: "comment"; text: string }
  | { type: "rav_start" }
  | { type: "rav_end" }
  | { type: "nag"; value: string }
  | { type: "result"; value: PgnResult }
  | { type: "move"; san: string; inlineNags: string[] };

const SYMBOLIC_NAG_MAP: Record<string, string> = {
  "!": "$1",
  "?": "$2",
  "!!": "$3",
  "??": "$4",
  "!?": "$5",
  "?!": "$6",
};

const VALID_RESULTS = new Set<string>(["1-0", "0-1", "1/2-1/2", "*"]);

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f";
}

function unescapeHeaderValue(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === '"' || next === "\\") {
        out += next;
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function escapeHeaderValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeSanAndInlineNags(rawWord: string): { san: string; inlineNags: string[] } | null {
  // Check standalone symbolic NAGs like "!", "!!", "?!", etc.
  const standaloneNag = SYMBOLIC_NAG_MAP[rawWord];
  if (standaloneNag) {
    return null;
  }

  let word = rawWord;
  const inlineNags: string[] = [];

  // Strip trailing symbolic NAG annotation(s) such as "e4!", "Bb5??", "Nd5!?"
  const suffixMatch = /([!?]{1,2})$/.exec(word);
  if (suffixMatch?.[1]) {
    const mapped = SYMBOLIC_NAG_MAP[suffixMatch[1]];
    if (mapped) {
      inlineNags.push(mapped);
      word = word.slice(0, -suffixMatch[1].length);
    }
  }

  // Normalize numeric castling notation
  if (/^0-0-0([+#]?)$/.test(word)) {
    word = word.replace(/^0-0-0/, "O-O-O");
  } else if (/^0-0([+#]?)$/.test(word)) {
    word = word.replace(/^0-0/, "O-O");
  }

  if (word.length === 0) {
    return null;
  }

  return { san: word, inlineNags };
}

function tokenizePgn(pgnText: string): PgnToken[] {
  const input = pgnText.startsWith("\uFEFF") ? pgnText.slice(1) : pgnText;
  const tokens: PgnToken[] = [];
  const len = input.length;
  let i = 0;
  let ravDepth = 0;

  while (i < len) {
    const ch = input[i]!;

    // Skip whitespace
    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    // PGN "%" line-escape mechanism (only at column 0 / start of line)
    if (ch === "%" && (i === 0 || input[i - 1] === "\n")) {
      while (i < len && input[i] !== "\n") {
        i++;
      }
      continue;
    }

    // Rest-of-line comment ";"
    if (ch === ";") {
      i++;
      const start = i;
      while (i < len && input[i] !== "\n") {
        i++;
      }
      const text = input.slice(start, i).replace(/\r$/, "").trim();
      if (text.length > 0) {
        tokens.push({ type: "comment", text });
      }
      continue;
    }

    // Brace comment "{ ... }"
    if (ch === "{") {
      i++;
      const start = i;
      while (i < len && input[i] !== "}") {
        i++;
      }
      const text = input.slice(start, i).trim();
      if (i < len && input[i] === "}") {
        i++;
      }
      tokens.push({ type: "comment", text });
      continue;
    }

    // Header tag pair "[Key "Value"]" (only valid outside RAVs)
    if (ch === "[" && ravDepth === 0) {
      const saveIdx = i;
      i++;
      while (i < len && isWhitespace(input[i]!)) i++;
      const keyStart = i;
      while (i < len && /[A-Za-z0-9_-]/.test(input[i]!)) i++;
      const key = input.slice(keyStart, i);
      while (i < len && isWhitespace(input[i]!)) i++;

      if (key.length > 0 && i < len && input[i] === '"') {
        i++; // skip opening quote
        const valStart = i;
        while (i < len) {
          if (input[i] === "\\" && i + 1 < len) {
            i += 2;
            continue;
          }
          if (input[i] === '"') {
            break;
          }
          i++;
        }
        const rawVal = input.slice(valStart, i);
        if (i < len && input[i] === '"') i++;
        while (i < len && isWhitespace(input[i]!)) i++;
        if (i < len && input[i] === "]") {
          i++;
          tokens.push({
            type: "header",
            key,
            value: unescapeHeaderValue(rawVal),
          });
          continue;
        }
      }
      // Malformed bracket — skip past closing bracket or advance one char
      i = saveIdx + 1;
      continue;
    }

    // RAV start/end
    if (ch === "(") {
      ravDepth++;
      tokens.push({ type: "rav_start" });
      i++;
      continue;
    }
    if (ch === ")") {
      if (ravDepth > 0) ravDepth--;
      tokens.push({ type: "rav_end" });
      i++;
      continue;
    }

    // Numeric NAG "$<digits>"
    if (ch === "$") {
      const start = i;
      i++;
      while (i < len && /[0-9]/.test(input[i]!)) {
        i++;
      }
      const nag = input.slice(start, i);
      if (nag.length > 1) {
        tokens.push({ type: "nag", value: nag });
      }
      continue;
    }

    // Word token (result, move number, ellipsis, SAN move, or symbolic NAG)
    const start = i;
    while (
      i < len &&
      !isWhitespace(input[i]!) &&
      input[i] !== "(" &&
      input[i] !== ")" &&
      input[i] !== "{" &&
      input[i] !== "}" &&
      input[i] !== ";" &&
      input[i] !== "[" &&
      input[i] !== "]"
    ) {
      i++;
    }

    const word = input.slice(start, i);
    if (word.length === 0) {
      i++;
      continue;
    }

    // Standalone game termination marker
    if (VALID_RESULTS.has(word)) {
      tokens.push({ type: "result", value: word as PgnResult });
      continue;
    }

    // Move number ("1.", "1...", "12.") or ellipsis ("...")
    if (/^\d+\.+$/.test(word) || /^\.+$/.test(word)) {
      continue;
    }

    // Move number attached directly to a move without space (e.g. "1.e4" or "1...e5")
    const attachedMoveMatch = /^\d+\.+(.+)$/.exec(word);
    const candidate = attachedMoveMatch?.[1] ?? word;

    // Standalone symbolic NAG ("!", "??", etc.)
    const standaloneNag = SYMBOLIC_NAG_MAP[candidate];
    if (standaloneNag) {
      tokens.push({ type: "nag", value: standaloneNag });
      continue;
    }

    const parsedMove = normalizeSanAndInlineNags(candidate);
    if (parsedMove) {
      tokens.push({
        type: "move",
        san: parsedMove.san,
        inlineNags: parsedMove.inlineNags,
      });
    }
  }

  return tokens;
}

interface TokenCursor {
  tokens: readonly PgnToken[];
  index: number;
}

function skipBalancedRav(cursor: TokenCursor): void {
  let depth = 1;
  while (cursor.index < cursor.tokens.length && depth > 0) {
    const tok = cursor.tokens[cursor.index]!;
    cursor.index++;
    if (tok.type === "rav_start") {
      depth++;
    } else if (tok.type === "rav_end") {
      depth--;
    }
  }
}

function parseSequence(
  cursor: TokenCursor,
  siblingArray: PgnMoveNode[],
  rootCommentsTarget: string[] | null,
): PgnResult | null {
  const pendingComments: string[] = [];
  let lastMove: PgnMoveNode | null = null;
  let lastMoveSiblingArray: PgnMoveNode[] = siblingArray;
  const explicitResult: PgnResult | null = null;

  while (cursor.index < cursor.tokens.length) {
    const tok = cursor.tokens[cursor.index]!;

    // Inside a RAV, stop on ")"
    if (tok.type === "rav_end") {
      if (rootCommentsTarget === null) {
        cursor.index++;
        return explicitResult;
      }
      // Stray ")" at top-level — ignore safely
      cursor.index++;
      continue;
    }

    // At top-level, a new header tag starts the next game
    if (tok.type === "header" && rootCommentsTarget !== null) {
      return explicitResult;
    }

    // Game result terminates top-level movetext
    if (tok.type === "result") {
      cursor.index++;
      if (rootCommentsTarget !== null) {
        return tok.value;
      }
      // Inside a RAV, ignore stray result tokens
      continue;
    }

    if (tok.type === "comment") {
      cursor.index++;
      if (lastMove !== null) {
        lastMove.comments.push(tok.text);
      } else if (rootCommentsTarget !== null) {
        rootCommentsTarget.push(tok.text);
      } else {
        // PGNA §4: comment immediately after "(" before first RAV move attaches to first move
        pendingComments.push(tok.text);
      }
      continue;
    }

    if (tok.type === "nag") {
      cursor.index++;
      if (lastMove !== null) {
        lastMove.nags.push(tok.value);
      }
      continue;
    }

    if (tok.type === "rav_start") {
      cursor.index++;
      if (lastMove === null) {
        // PGNA §3: RAV appearing before any move in a sequence is malformed and ignored
        skipBalancedRav(cursor);
      } else {
        parseSequence(cursor, lastMoveSiblingArray, null);
      }
      continue;
    }

    if (tok.type === "move") {
      cursor.index++;
      const node: PgnMoveNode = {
        san: tok.san,
        nags: [...tok.inlineNags],
        comments: pendingComments.length > 0 ? [...pendingComments] : [],
        children: [],
      };
      pendingComments.length = 0;

      if (lastMove === null) {
        siblingArray.push(node);
        lastMoveSiblingArray = siblingArray;
      } else {
        lastMove.children.push(node);
        lastMoveSiblingArray = lastMove.children;
      }
      lastMove = node;
      continue;
    }

    cursor.index++;
  }

  return explicitResult;
}

/**
 * Parses a single- or multi-game PGN string into a structured AST.
 */
export function parsePgnGames(pgnText: string): PgnGameDocument[] {
  const tokens = tokenizePgn(pgnText);
  if (tokens.length === 0) {
    return [];
  }

  const cursor: TokenCursor = { tokens, index: 0 };
  const games: PgnGameDocument[] = [];

  while (cursor.index < cursor.tokens.length) {
    const headers: Record<string, string> = {};
    const rootComments: string[] = [];
    const rootMoves: PgnMoveNode[] = [];

    let hasHeaders = false;
    while (cursor.index < cursor.tokens.length && cursor.tokens[cursor.index]!.type === "header") {
      const tok = cursor.tokens[cursor.index]!;
      if (tok.type === "header") {
        headers[tok.key] = tok.value;
        hasHeaders = true;
      }
      cursor.index++;
    }

    const startIdxAfterHeaders = cursor.index;
    const explicitResult = parseSequence(cursor, rootMoves, rootComments);
    const consumedMovetext = cursor.index > startIdxAfterHeaders;

    if (!hasHeaders && !consumedMovetext) {
      // Defensive guard against unexpected unconsumed tokens
      cursor.index++;
      continue;
    }

    const headerResult = headers["Result"];
    const fallbackResult: PgnResult =
      headerResult === "1-0" || headerResult === "0-1" || headerResult === "1/2-1/2"
        ? headerResult
        : "*";
    const result: PgnResult = explicitResult ?? fallbackResult;

    games.push({
      headers,
      rootComments,
      rootMoves,
      result,
    });
  }

  return games;
}

function getInitialTurnAndMoveNumber(headers: Record<string, string>): {
  turn: "w" | "b";
  moveNumber: number;
} {
  const fen = headers["FEN"];
  if (!fen) {
    return { turn: "w", moveNumber: 1 };
  }
  const parts = fen.trim().split(/\s+/);
  const turn: "w" | "b" = parts[1] === "b" ? "b" : "w";
  const parsedMoveNum = parts[5] ? Number.parseInt(parts[5], 10) : 1;
  const moveNumber = Number.isFinite(parsedMoveNum) && parsedMoveNum >= 1 ? parsedMoveNum : 1;
  return { turn, moveNumber };
}

function serializeMoveBranch(
  siblings: readonly PgnMoveNode[],
  turn: "w" | "b",
  moveNumber: number,
  forceMoveNumber: boolean,
  parts: string[],
): void {
  const primary = siblings[0];
  if (!primary) return;

  if (turn === "w") {
    parts.push(`${moveNumber}. ${primary.san}`);
  } else if (forceMoveNumber) {
    parts.push(`${moveNumber}... ${primary.san}`);
  } else {
    parts.push(primary.san);
  }

  for (const nag of primary.nags) {
    parts.push(nag);
  }

  for (const comment of primary.comments) {
    parts.push(`{ ${comment} }`);
  }

  let emittedInterrupter = primary.comments.length > 0;

  for (let i = 1; i < siblings.length; i++) {
    const alt = siblings[i]!;
    const ravParts: string[] = [];
    serializeMoveBranch([alt], turn, moveNumber, true, ravParts);
    parts.push(`(${ravParts.join(" ")})`);
    emittedInterrupter = true;
  }

  if (primary.children.length > 0) {
    const nextTurn: "w" | "b" = turn === "w" ? "b" : "w";
    const nextMoveNumber = turn === "b" ? moveNumber + 1 : moveNumber;
    serializeMoveBranch(
      primary.children,
      nextTurn,
      nextMoveNumber,
      emittedInterrupter,
      parts,
    );
  }
}

/**
 * Serializes one or more PgnGameDocument ASTs back into standard PGN text.
 */
export function serializePgnGames(games: readonly PgnGameDocument[]): string {
  return games
    .map((game) => {
      const headerLines = Object.entries(game.headers).map(
        ([key, value]) => `[${key} "${escapeHeaderValue(value)}"]`,
      );

      const moveParts: string[] = [];
      for (const rootComment of game.rootComments) {
        moveParts.push(`{ ${rootComment} }`);
      }

      const { turn, moveNumber } = getInitialTurnAndMoveNumber(game.headers);
      if (game.rootMoves.length > 0) {
        serializeMoveBranch(game.rootMoves, turn, moveNumber, true, moveParts);
      }

      moveParts.push(game.result);
      const movetext = moveParts.join(" ");

      if (headerLines.length === 0) {
        return movetext;
      }
      return `${headerLines.join("\n")}\n\n${movetext}`;
    })
    .join("\n\n");
}
