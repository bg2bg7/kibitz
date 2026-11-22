import type { ChessPosition } from "@suite/chess-core";
import { describe, expect, it } from "vitest";
import { createHallApp, handleTournamentMoveMessage } from "./app.js";

describe("@suite/hall server", () => {
  it("exposes /health confirming no open lobby and no chat", async () => {
    const app = createHallApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      service: "hall",
      mode: "scheduled-club-tournaments-only",
      openLobby: false,
      chatEnabled: false,
    });
  });

  it("validates tournament moves via @suite/chess-core and rejects illegal moves", () => {
    const games = new Map<string, ChessPosition>();

    const legal = handleTournamentMoveMessage(
      JSON.stringify({ type: "move", gameId: "round1-board1", from: "e2", to: "e4" }),
      games,
    );
    expect(legal.type).toBe("move_accepted");
    expect(legal.san).toBe("e4");

    const illegal = handleTournamentMoveMessage(
      JSON.stringify({ type: "move", gameId: "round1-board1", from: "e7", to: "e2" }),
      games,
    );
    expect(illegal.type).toBe("move_rejected");
    expect(illegal.reason).toContain("Illegal move");
  });
});
