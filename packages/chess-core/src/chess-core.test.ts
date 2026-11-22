import { describe, expect, it } from "vitest";
import {
  ChessPosition,
  INITIAL_FEN,
  calculateEloDelta,
  calculateSolkoff,
  generatePairings,
  isLegalMove,
  parsePgnGames,
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
});
