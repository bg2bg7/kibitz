import { describe, expect, it } from "vitest";
import {
  ChessPosition,
  INITIAL_FEN,
  calculateEloDelta,
  calculateSolkoff,
  generatePairings,
  getPgnSiblingRavMap,
  getPgnTextualNodeOrder,
  isLegalMove,
  parsePgnGames,
  serializePgnGames,
} from "./index.js";

describe("@suite/chess-core", () => {
  it("validates legal and illegal chess moves from initial FEN", () => {
    const pos = new ChessPosition();
    expect(pos.fen).toBe(INITIAL_FEN);
    expect(pos.getLegalMoves()).toHaveLength(20);

    const applied = pos.tryMove({ from: "e2", to: "e4" });
    expect(applied?.san).toBe("e4");
    expect(pos.turn).toBe("b");

    expect(isLegalMove(INITIAL_FEN, "e4")).toBe(true);
    expect(isLegalMove(INITIAL_FEN, { from: "e2", to: "e5" })).toBe(false);
  });

  it("extracts headers in PGN stub and generates deterministic pairings", () => {
    const games = parsePgnGames('[Event "Club Round 1"]\n[Result "1-0"]\n\n1. e4 e5 1-0');
    expect(games).toHaveLength(1);
    expect(games[0]?.headers["Event"]).toBe("Club Round 1");

    const pairings = generatePairings(
      [
        { id: "p1", rating: 1400, score: 1, opponentsPlayed: [], colorHistory: [], active: true },
        { id: "p2", rating: 1200, score: 1, opponentsPlayed: [], colorHistory: [], active: true },
        { id: "p3", rating: 1100, score: 0, opponentsPlayed: [], colorHistory: [], active: true },
      ],
      "swiss",
    );
    expect(pairings).toHaveLength(2);
    expect(pairings[0]).toEqual({ board: 1, whitePlayerId: "p1", blackPlayerId: "p2" });
    expect(pairings[1]).toEqual({ board: 2, whitePlayerId: "p3", blackPlayerId: null });
    expect(calculateSolkoff(["p1", "p2"], { p1: 3, p2: 2.5 })).toBe(5.5);
  });

  it("calculates Elo rating deltas symmetrically", () => {
    expect(
      calculateEloDelta({ playerRating: 1500, opponentRating: 1500, score: 1, kFactor: 20 }),
    ).toBe(10);
    expect(
      calculateEloDelta({ playerRating: 1500, opponentRating: 1500, score: 0.5, kFactor: 20 }),
    ).toBe(0);
  });

  it("parses multi-game PGNs with nested RAVs, root/variation comments, NAGs, and [FEN]", () => {
    const pgn = [
      '[Event "Game 1 \\"Finals\\""]',
      '[White "Alice"]',
      '[Black "Bob"]',
      '[Result "1-0"]',
      "",
      "{ Study intro [%at #1] } 1. e4! { Control center [%cal Ge2e4] } 1... e5 ( { Sicilian } 1... c5 $5 2. Nf3 ( 2. Nc3 Nc6 ) ) ( 1... e6 ) 2. Nf3 1-0",
      "",
      '[Event "Endgame Puzzle"]',
      '[FEN "4k3/4P3/4K3/8/8/8/8/8 w - - 0 40"]',
      '[Result "*"]',
      "",
      "40. Kd6 Kf7 *",
    ].join("\n");

    const games = parsePgnGames(pgn);
    expect(games).toHaveLength(2);

    const g0 = games[0]!;
    expect(g0.headers["Event"]).toBe('Game 1 "Finals"');
    expect(g0.rootComments).toEqual(["Study intro [%at #1]"]);
    expect(g0.result).toBe("1-0");
    expect(g0.rootMoves).toHaveLength(1);

    const e4 = g0.rootMoves[0]!;
    expect(e4.san).toBe("e4");
    expect(e4.nags).toEqual(["$1"]);
    expect(e4.comments).toEqual(["Control center [%cal Ge2e4]"]);
    expect(e4.children.map((c) => c.san)).toEqual(["e5", "c5", "e6"]);

    const c5 = e4.children[1]!;
    expect(c5.comments).toEqual(["Sicilian"]);
    expect(c5.nags).toEqual(["$5"]);
    expect(c5.children.map((c) => c.san)).toEqual(["Nf3", "Nc3"]);
    expect(c5.children[1]?.children[0]?.san).toBe("Nc6");

    const e5 = e4.children[0]!;
    expect(e5.children[0]?.san).toBe("Nf3");

    const g1 = games[1]!;
    expect(g1.headers["Event"]).toBe("Endgame Puzzle");
    expect(g1.rootMoves[0]?.san).toBe("Kd6");
    expect(g1.rootMoves[0]?.children[0]?.san).toBe("Kf7");

    // Round-trip serialization
    const serialized = serializePgnGames(games);
    expect(serialized).toContain('[Event "Game 1 \\"Finals\\""]');
    expect(serialized).toContain("40. Kd6 Kf7 *");
    const reparsed = parsePgnGames(serialized);
    expect(reparsed).toEqual(games);
  });

  it("ignores malformed leading RAVs before any move in a sequence", () => {
    const games = parsePgnGames("(1. d4) 1. e4 e5 *");
    expect(games).toHaveLength(1);
    expect(games[0]?.rootMoves.map((m) => m.san)).toEqual(["e4"]);
  });

  it("tokenizes numeric NAGs attached directly to SAN moves and leading ellipsis without move number", () => {
    const games = parsePgnGames("1. e4$1 ...e5$6 ( ...c5$5 ) 2. Nf3$3 *");
    expect(games).toHaveLength(1);
    const e4 = games[0]!.rootMoves[0]!;
    expect(e4.san).toBe("e4");
    expect(e4.nags).toEqual(["$1"]);
    expect(e4.children.map((c) => c.san)).toEqual(["e5", "c5"]);
    expect(e4.children[0]?.nags).toEqual(["$6"]);
    expect(e4.children[1]?.nags).toEqual(["$5"]);
    expect(e4.children[0]?.children[0]?.san).toBe("Nf3");
    expect(e4.children[0]?.children[0]?.nags).toEqual(["$3"]);
  });

  it("sanitizes brace characters in comments and strips newlines from header values on serialization", () => {
    const serialized = serializePgnGames([
      {
        headers: {
          Event: "Line 1\nLine 2\r\nLine 3\rEnd",
          Result: "*",
        },
        rootComments: ["Intro {nested} } breakout"],
        rootMoves: [
          {
            san: "e4",
            nags: [],
            comments: ["Move } 1. d4 { injected"],
            children: [],
          },
        ],
        result: "*",
      },
    ]);

    expect(serialized).toContain('[Event "Line 1 Line 2 Line 3 End"]');
    // No line breaks inside header tag lines
    for (const line of serialized.split("\n")) {
      if (line.startsWith("[")) {
        expect(line.endsWith("]")).toBe(true);
      }
    }

    const reparsed = parsePgnGames(serialized);
    expect(reparsed).toHaveLength(1);
    expect(reparsed[0]?.headers["Event"]).toBe("Line 1 Line 2 Line 3 End");
    expect(reparsed[0]?.rootComments).toEqual(["Intro nested  breakout"]);
    expect(reparsed[0]?.rootMoves).toHaveLength(1);
    expect(reparsed[0]?.rootMoves[0]?.san).toBe("e4");
    expect(reparsed[0]?.rootMoves[0]?.comments).toEqual(["Move  1. d4  injected"]);
    expect(reparsed[0]?.rootMoves[0]?.children).toEqual([]);
  });

  it("preserves canonical NodeIds and textual order for nested same-ply variations across round-trips", () => {
    const pgn = "1. e4 (1. d4 (1. c4) 1... d5) 1... e5 *";
    const games = parsePgnGames(pgn);
    expect(games).toHaveLength(1);

    const game = games[0]!;
    expect(game.rootMoves.map((m) => m.san)).toEqual(["e4", "d4", "c4"]);
    expect(game.rootMoves[0]?.ravAnchorIndex).toBeUndefined();
    expect(game.rootMoves[1]?.ravAnchorIndex).toBeUndefined();
    expect(game.rootMoves[2]?.ravAnchorIndex).toBe(1);

    const expectedOrder = [
      { nodeId: "g0/0", san: "e4", ply: 1, siblingIndex: 0 },
      { nodeId: "g0/1", san: "d4", ply: 1, siblingIndex: 1 },
      { nodeId: "g0/2", san: "c4", ply: 1, siblingIndex: 2 },
      { nodeId: "g0/1.0", san: "d5", ply: 2, siblingIndex: 0 },
      { nodeId: "g0/0.0", san: "e5", ply: 2, siblingIndex: 0 },
    ];

    expect(
      getPgnTextualNodeOrder(game, 0).map(({ nodeId, node, ply, siblingIndex }) => ({
        nodeId,
        san: node.san,
        ply,
        siblingIndex,
      })),
    ).toEqual(expectedOrder);

    const serialized = serializePgnGames(games);
    expect(serialized).toBe("1. e4 (1. d4 (1. c4) 1... d5) 1... e5 *");

    const reparsed = parsePgnGames(serialized);
    expect(reparsed).toEqual(games);
    expect(
      getPgnTextualNodeOrder(reparsed[0]!, 0).map(({ nodeId, node, ply, siblingIndex }) => ({
        nodeId,
        san: node.san,
        ply,
        siblingIndex,
      })),
    ).toEqual(expectedOrder);
  });

  it("preserves multi-level nested same-ply RAVs at root and deeper plies and guards invalid anchors", () => {
    const pgn =
      "1. e4 (1. d4 (1. c4 (1. Nf3 Nf6) 1... e6) (1. f4) 1... d5) (1. b3) 1... e5 (1... c5 (1... e6) 2. Nf3) 2. Nf3 *";
    const games = parsePgnGames(pgn);
    expect(games).toHaveLength(1);

    const expected = [
      { nodeId: "g0/0", san: "e4" },
      { nodeId: "g0/1", san: "d4" },
      { nodeId: "g0/2", san: "c4" },
      { nodeId: "g0/3", san: "Nf3" },
      { nodeId: "g0/3.0", san: "Nf6" },
      { nodeId: "g0/2.0", san: "e6" },
      { nodeId: "g0/4", san: "f4" },
      { nodeId: "g0/1.0", san: "d5" },
      { nodeId: "g0/5", san: "b3" },
      { nodeId: "g0/0.0", san: "e5" },
      { nodeId: "g0/0.1", san: "c5" },
      { nodeId: "g0/0.2", san: "e6" },
      { nodeId: "g0/0.1.0", san: "Nf3" },
      { nodeId: "g0/0.0.0", san: "Nf3" },
    ];

    expect(
      getPgnTextualNodeOrder(games[0]!).map(({ nodeId, node }) => ({ nodeId, san: node.san })),
    ).toEqual(expected);

    const serialized = serializePgnGames(games);
    const reparsed = parsePgnGames(serialized);
    expect(reparsed).toEqual(games);
    expect(
      getPgnTextualNodeOrder(reparsed[0]!).map(({ nodeId, node }) => ({ nodeId, san: node.san })),
    ).toEqual(expected);

    // Stale/invalid ravAnchorIndex values fall back safely to sibling 0 without cycles or dropped nodes
    const malformedSiblings = [
      { san: "e4", nags: [], comments: [], children: [] },
      { san: "d4", nags: [], comments: [], children: [], ravAnchorIndex: 1 },
      { san: "c4", nags: [], comments: [], children: [], ravAnchorIndex: -3 },
      { san: "Nf3", nags: [], comments: [], children: [], ravAnchorIndex: 99 },
    ];
    expect(getPgnSiblingRavMap(malformedSiblings)).toEqual([[1, 2, 3], [], [], []]);
    expect(
      serializePgnGames([{ headers: {}, rootComments: [], rootMoves: malformedSiblings, result: "*" }]),
    ).toBe("1. e4 (1. d4) (1. c4) (1. Nf3) *");
  });

  it("normalizes LF, CRLF, and CR-only line endings identically for ; comments and % escape lines", () => {
    const lines = [
      "% leading escape line should be ignored",
      '[Event "Line Ending Test"]',
      '[White "WhitePlayer"]',
      '[Black "BlackPlayer"]',
      '[Result "1-0"]',
      "",
      "; root semicolon comment",
      "1. e4 ; after e4 comment",
      "% mid-game escape line must not swallow 1... e5",
      "1... e5 (1... c5 ; sicilian line comment",
      "2. Nf3) 2. Nf3 { multiline",
      "brace comment } 2... Nc6 ; final comment",
      "1-0",
    ];

    const lf = lines.join("\n");
    const crlf = lines.join("\r\n");
    const cr = lines.join("\r");

    const parsedLf = parsePgnGames(lf);
    const parsedCrlf = parsePgnGames(crlf);
    const parsedCr = parsePgnGames(cr);

    expect(parsedCrlf).toEqual(parsedLf);
    expect(parsedCr).toEqual(parsedLf);

    expect(parsedCr).toHaveLength(1);
    const game = parsedCr[0]!;
    expect(game.headers["Event"]).toBe("Line Ending Test");
    expect(game.rootComments).toEqual(["root semicolon comment"]);
    expect(game.result).toBe("1-0");

    const e4 = game.rootMoves[0]!;
    expect(e4.san).toBe("e4");
    expect(e4.comments).toEqual(["after e4 comment"]);
    expect(e4.children.map((c) => c.san)).toEqual(["e5", "c5"]);
    expect(e4.children[1]?.comments).toEqual(["sicilian line comment"]);
    expect(e4.children[1]?.children[0]?.san).toBe("Nf3");

    const nf3 = e4.children[0]!.children[0]!;
    expect(nf3.san).toBe("Nf3");
    expect(nf3.comments).toEqual(["multiline\nbrace comment"]);
    expect(nf3.children[0]?.san).toBe("Nc6");
    expect(nf3.children[0]?.comments).toEqual(["final comment"]);
  });
});

