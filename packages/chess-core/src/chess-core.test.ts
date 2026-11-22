import { describe, expect, it } from "vitest";
import {
  ChessPosition,
  INITIAL_FEN,
  calculateEloDelta,
  calculateSolkoff,
  generatePairings,
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
});

