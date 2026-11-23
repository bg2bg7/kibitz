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
  /**
   * Optional index within the same sibling array of the move this RAV was anchored after
   * in source PGN text. Omitted (defaults to `0`) for RAVs attached directly to the
   * mainline sibling `children[0]`; set to `k >= 1` when nested inside another same-ply RAV.
   */
  ravAnchorIndex?: number;
}

export interface PgnTextualNodeEntry {
  /** Canonical PGNA NodeId (e.g. `g0/0`, `g0/1`, `g0/2`, `g0/1.0`). */
  nodeId: string;
  /** 1-based ply depth from the game root. */
  ply: number;
  /** 0-based index within the parent's children array (`0` = mainline). */
  siblingIndex: number;
  /** The PGN move AST node. */
  node: PgnMoveNode;
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
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n|[\r\n]/g, " ");
}

function sanitizeBraceComment(comment: string): string {
  return comment.replace(/[{}]/g, "").trim();
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
  const withoutBom = pgnText.startsWith("\uFEFF") ? pgnText.slice(1) : pgnText;
  const input = withoutBom.replace(/\r\n?/g, "\n");
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
      const text = input.slice(start, i).trim();
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
      input[i] !== "]" &&
      input[i] !== "$"
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

    // Move number or ellipsis attached directly to a move without space (e.g. "1.e4", "1...e5", "...e5")
    const attachedMoveMatch = /^(?:\d+\.+|\.+)(.+)$/.exec(word);
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
  ravAnchorIndex = 0,
): PgnResult | null {
  const pendingComments: string[] = [];
  let lastMove: PgnMoveNode | null = null;
  let lastMoveSiblingArray: PgnMoveNode[] = siblingArray;
  let lastMoveSiblingIndex = -1;
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
        parseSequence(cursor, lastMoveSiblingArray, null, lastMoveSiblingIndex);
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
        const insertedIndex = siblingArray.length;
        if (rootCommentsTarget === null && ravAnchorIndex > 0 && ravAnchorIndex < insertedIndex) {
          node.ravAnchorIndex = ravAnchorIndex;
        }
        siblingArray.push(node);
        lastMoveSiblingArray = siblingArray;
        lastMoveSiblingIndex = insertedIndex;
      } else {
        const insertedIndex = lastMove.children.length;
        lastMove.children.push(node);
        lastMoveSiblingArray = lastMove.children;
        lastMoveSiblingIndex = insertedIndex;
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

function resolveRavAnchorIndex(node: PgnMoveNode, siblingIndex: number): number {
  const raw = node.ravAnchorIndex;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw < siblingIndex) {
    return raw;
  }
  return 0;
}

/**
 * Groups each sibling index `i` in a PGN sibling array with the indices of RAVs directly
 * anchored immediately after sibling `i` in PGN textual order.
 *
 * Guarantees a cycle-free tree rooted at index `0` even if `ravAnchorIndex` metadata is
 * absent or stale after manual AST mutations.
 */
export function getPgnSiblingRavMap(siblings: readonly PgnMoveNode[]): number[][] {
  const anchored: number[][] = siblings.map(() => []);
  for (let i = 1; i < siblings.length; i++) {
    const anchor = resolveRavAnchorIndex(siblings[i]!, i);
    anchored[anchor]!.push(i);
  }
  return anchored;
}

function makeChildNodeId(parentId: string, childIndex: number): string {
  return parentId.includes("/") ? `${parentId}.${childIndex}` : `${parentId}/${childIndex}`;
}

/**
 * Returns all move nodes of a `PgnGameDocument` in exact PGN textual document order
 * (preserving nested same-ply RAV placement) along with each node's canonical `NodeId`.
 */
export function getPgnTextualNodeOrder(
  game: PgnGameDocument,
  gameIndex = 0,
): PgnTextualNodeEntry[] {
  const entries: PgnTextualNodeEntry[] = [];

  const walkSiblings = (
    siblings: readonly PgnMoveNode[],
    parentNodeId: string,
    parentPly: number,
  ): void => {
    if (siblings.length === 0) return;
    const ravMap = getPgnSiblingRavMap(siblings);

    const visitSibling = (siblingIndex: number): void => {
      const node = siblings[siblingIndex];
      if (!node) return;
      const nodeId = makeChildNodeId(parentNodeId, siblingIndex);
      const ply = parentPly + 1;
      entries.push({ nodeId, ply, siblingIndex, node });

      for (const ravIndex of ravMap[siblingIndex] ?? []) {
        visitSibling(ravIndex);
      }

      walkSiblings(node.children, nodeId, ply);
    };

    visitSibling(0);
  };

  walkSiblings(game.rootMoves, `g${gameIndex}`, 0);
  return entries;
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

function serializeSiblingNode(
  siblings: readonly PgnMoveNode[],
  ravMap: readonly (readonly number[])[],
  siblingIndex: number,
  turn: "w" | "b",
  moveNumber: number,
  forceMoveNumber: boolean,
  parts: string[],
): void {
  const node = siblings[siblingIndex];
  if (!node) return;

  if (turn === "w") {
    parts.push(`${moveNumber}. ${node.san}`);
  } else if (forceMoveNumber) {
    parts.push(`${moveNumber}... ${node.san}`);
  } else {
    parts.push(node.san);
  }

  for (const nag of node.nags) {
    parts.push(nag);
  }

  for (const comment of node.comments) {
    const safe = sanitizeBraceComment(comment);
    parts.push(safe.length > 0 ? `{ ${safe} }` : "{}");
  }

  let emittedInterrupter = node.comments.length > 0;

  for (const ravIndex of ravMap[siblingIndex] ?? []) {
    const ravParts: string[] = [];
    serializeSiblingNode(siblings, ravMap, ravIndex, turn, moveNumber, true, ravParts);
    parts.push(`(${ravParts.join(" ")})`);
    emittedInterrupter = true;
  }

  if (node.children.length > 0) {
    const nextTurn: "w" | "b" = turn === "w" ? "b" : "w";
    const nextMoveNumber = turn === "b" ? moveNumber + 1 : moveNumber;
    serializeMoveBranch(node.children, nextTurn, nextMoveNumber, emittedInterrupter, parts);
  }
}

function serializeMoveBranch(
  siblings: readonly PgnMoveNode[],
  turn: "w" | "b",
  moveNumber: number,
  forceMoveNumber: boolean,
  parts: string[],
): void {
  if (siblings.length === 0) return;
  const ravMap = getPgnSiblingRavMap(siblings);
  serializeSiblingNode(siblings, ravMap, 0, turn, moveNumber, forceMoveNumber, parts);
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
        const safe = sanitizeBraceComment(rootComment);
        moveParts.push(safe.length > 0 ? `{ ${safe} }` : "{}");
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
