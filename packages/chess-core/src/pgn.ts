/**
 * Multi-game PGN AST preserving comments, NAGs, and Recursive Annotation Variations (RAVs).
 * Contract stub ready for full parser/serializer implementation.
 */

export interface PgnMoveNode {
  san: string;
  nags: string[];
  comments: string[];
  /** Mainline continuation is children[0]; RAV alternatives are children[1..k]. */
  children: PgnMoveNode[];
}

export interface PgnGameDocument {
  headers: Record<string, string>;
  rootComments: string[];
  /** Mainline first move is rootMoves[0]; alternative first moves are rootMoves[1..k]. */
  rootMoves: PgnMoveNode[];
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
}

export function parsePgnGames(pgnText: string): PgnGameDocument[] {
  const trimmed = pgnText.trim();
  if (!trimmed) {
    return [];
  }

  // Minimal header extraction stub preserving contract shape for downstream apps.
  const headers: Record<string, string> = {};
  const headerRegex = /^\[([A-Za-z0-9_]+)\s+"([^"]*)"\]$/gm;
  let match: RegExpExecArray | null = headerRegex.exec(trimmed);
  while (match !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) {
      headers[key] = value;
    }
    match = headerRegex.exec(trimmed);
  }

  const rawResult = headers["Result"];
  const result =
    rawResult === "1-0" || rawResult === "0-1" || rawResult === "1/2-1/2" ? rawResult : "*";

  return [
    {
      headers,
      rootComments: [],
      rootMoves: [],
      result,
    },
  ];
}

export function serializePgnGames(games: readonly PgnGameDocument[]): string {
  return games
    .map((game) => {
      const headerLines = Object.entries(game.headers).map(([key, value]) => `[${key} "${value}"]`);
      return [...headerLines, "", game.result].join("\n").trim();
    })
    .join("\n\n");
}
