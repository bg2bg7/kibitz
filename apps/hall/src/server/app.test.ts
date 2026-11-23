import { resolveAuthConfig, signSessionToken } from "@suite/auth-core";
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

  it("allows authenticated read-only tournament pulls via shared KibitzID cookie from offline Arbiter origin", async () => {
    const authConfig = resolveAuthConfig({
      AUTH_JWT_SECRET: "shared-cross-service-test-secret-over-32-bytes",
    });
    const app = createHallApp({ authConfig });

    const unauth = await app.request("/api/tournaments");
    expect(unauth.status).toBe(401);

    const { token } = await signSessionToken(
      {
        sub: "22222222-2222-4222-8222-222222222222",
        handle: "coach_alice",
        role: "coach",
        programIds: [],
      },
      authConfig,
    );

    const pullRes = await app.request("/api/tournaments", {
      headers: {
        cookie: `kibitz_session=${token}`,
        origin: "http://localhost:5175",
      },
    });
    expect(pullRes.status).toBe(200);
    expect(pullRes.headers.get("access-control-allow-origin")).toBe("http://localhost:5175");
    expect(pullRes.headers.get("access-control-allow-credentials")).toBe("true");
    const body = (await pullRes.json()) as {
      mode: string;
      viewer: { handle: string; role: string };
      items: unknown[];
    };
    expect(body.mode).toBe("read_only_pull");
    expect(body.viewer.handle).toBe("coach_alice");
    expect(body.items).toEqual([]);
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
