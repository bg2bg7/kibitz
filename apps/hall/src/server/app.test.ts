import type { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import { resolveAuthConfig, signSessionToken } from "@suite/auth-core";
import type { ChessPosition } from "@suite/chess-core";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, type WebSocketServer } from "ws";
import {
  attachHallWebSocketServer,
  createHallApp,
  handleTournamentMoveMessage,
  isHallWebSocketEnabled,
  type MoveValidationResponse,
} from "./app.js";

async function startHallServer(app: ReturnType<typeof createHallApp>): Promise<{
  server: HttpServer;
  port: number;
}> {
  return await new Promise((resolve) => {
    const server = serve(
      { fetch: app.fetch, port: 0, hostname: "127.0.0.1" },
      (info) => {
        resolve({ server: server as unknown as HttpServer, port: info.port });
      },
    );
  });
}

async function closeHallServer(server: HttpServer, wss?: WebSocketServer): Promise<void> {
  if (wss) {
    for (const client of wss.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function connectWebSocket(url: string): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", (err) => reject(err));
  });
}

async function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
  });
}

async function sendMoveAndWait(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<MoveValidationResponse> {
  return await new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as MoveValidationResponse);
      } catch (err) {
        reject(err);
      }
    });
    ws.once("error", (err) => reject(err));
    ws.send(JSON.stringify(payload));
  });
}

describe("@suite/hall server", () => {
  it("exposes /health confirming no open lobby, no chat, and wsEnabled status", async () => {
    const defaultApp = createHallApp();
    const defaultRes = await defaultApp.request("/health");
    expect(defaultRes.status).toBe(200);
    expect(await defaultRes.json()).toEqual({
      status: "ok",
      service: "hall",
      mode: "scheduled-club-tournaments-only",
      openLobby: false,
      chatEnabled: false,
      wsEnabled: false,
    });

    const devWsApp = createHallApp({ wsEnabled: true });
    const devWsRes = await devWsApp.request("/health");
    expect(devWsRes.status).toBe(200);
    expect(await devWsRes.json()).toEqual({
      status: "ok",
      service: "hall",
      mode: "scheduled-club-tournaments-only",
      openLobby: false,
      chatEnabled: false,
      wsEnabled: true,
    });
  });

  it("disables Hall WebSocket by default and always disables it in production (HALL-01)", () => {
    expect(isHallWebSocketEnabled({})).toBe(false);
    expect(isHallWebSocketEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(isHallWebSocketEnabled({ HALL_ENABLE_DEV_WS: "false" })).toBe(false);
    expect(isHallWebSocketEnabled({ HALL_ENABLE_DEV_WS: "1" })).toBe(false);
    expect(isHallWebSocketEnabled({ HALL_ENABLE_DEV_WS: "" })).toBe(false);

    expect(isHallWebSocketEnabled({ HALL_ENABLE_DEV_WS: "true" })).toBe(true);
    expect(
      isHallWebSocketEnabled({ NODE_ENV: "development", HALL_ENABLE_DEV_WS: " true " }),
    ).toBe(true);
    expect(isHallWebSocketEnabled({ NODE_ENV: "test", HALL_ENABLE_DEV_WS: "TRUE" })).toBe(true);

    expect(
      isHallWebSocketEnabled({ NODE_ENV: "production", HALL_ENABLE_DEV_WS: "true" }),
    ).toBe(false);
    expect(
      isHallWebSocketEnabled({ NODE_ENV: "PRODUCTION", HALL_ENABLE_DEV_WS: "true" }),
    ).toBe(false);
    expect(
      isHallWebSocketEnabled({ NODE_ENV: " production ", HALL_ENABLE_DEV_WS: "true" }),
    ).toBe(false);
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

  it("enforces maxGames capacity without growing in-memory state beyond the limit (HALL-02)", () => {
    const games = new Map<string, ChessPosition>();

    const g1 = handleTournamentMoveMessage(
      JSON.stringify({ type: "move", gameId: "board-1", from: "e2", to: "e4" }),
      games,
      2,
    );
    expect(g1.type).toBe("move_accepted");

    const g2 = handleTournamentMoveMessage(
      JSON.stringify({ type: "move", gameId: "board-2", from: "d2", to: "d4" }),
      games,
      2,
    );
    expect(g2.type).toBe("move_accepted");
    expect(games.size).toBe(2);

    const overflow = handleTournamentMoveMessage(
      JSON.stringify({ type: "move", gameId: "board-3", from: "c2", to: "c4" }),
      games,
      2,
    );
    expect(overflow.type).toBe("move_rejected");
    expect(overflow.gameId).toBe("board-3");
    expect(overflow.reason).toMatch(/capacity/i);
    expect(games.size).toBe(2);
    expect(games.has("board-3")).toBe(false);

    // Existing games continue accepting legal moves even when room capacity is full.
    const g1Reply = handleTournamentMoveMessage(
      JSON.stringify({ type: "move", gameId: "board-1", from: "e7", to: "e5" }),
      games,
      2,
    );
    expect(g1Reply.type).toBe("move_accepted");
    expect(g1Reply.san).toBe("e5");
    expect(games.size).toBe(2);
  });

  it("rejects WebSocket upgrades to /ws when attachHallWebSocketServer is not attached while serving HTTP /health (HALL-01)", async () => {
    const app = createHallApp({ wsEnabled: false });
    const { server, port } = await startHallServer(app);

    try {
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toMatchObject({ status: "ok", wsEnabled: false });

      let opened = false;
      const wsResult = await new Promise<"rejected">((resolve) => {
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        client.once("open", () => {
          opened = true;
          client.close();
          resolve("rejected");
        });
        client.once("error", () => {
          resolve("rejected");
        });
        client.once("close", () => {
          resolve("rejected");
        });
      });

      expect(wsResult).toBe("rejected");
      expect(opened).toBe(false);

      const healthAfter = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthAfter.status).toBe(200);
    } finally {
      await closeHallServer(server);
    }
  });

  it("isolates per-connection and server WebSocket errors without disrupting other clients or HTTP /health (HALL-02)", async () => {
    const app = createHallApp({ wsEnabled: true });
    const { server, port } = await startHallServer(app);
    const onError = vi.fn<(err: Error, context: "server" | "connection") => void>();
    const wss = attachHallWebSocketServer(server, { onError });

    let client1: WebSocket | undefined;
    let client2: WebSocket | undefined;

    try {
      const serverSocket1Promise = new Promise<WebSocket>((resolve) => {
        wss.once("connection", (socket) => resolve(socket));
      });
      client1 = await connectWebSocket(`ws://127.0.0.1:${port}/ws`);
      const serverSocket1 = await serverSocket1Promise;

      const serverSocket2Promise = new Promise<WebSocket>((resolve) => {
        wss.once("connection", (socket) => resolve(socket));
      });
      client2 = await connectWebSocket(`ws://127.0.0.1:${port}/ws`);
      await serverSocket2Promise;

      const client1Closed = waitForClose(client1);
      const transportErr = new Error("simulated transport failure");
      expect(() => {
        serverSocket1.emit("error", transportErr);
      }).not.toThrow();

      await client1Closed;

      expect(onError).toHaveBeenCalledWith(transportErr, "connection");
      expect(client1.readyState).toBe(WebSocket.CLOSED);
      expect(serverSocket1.readyState).not.toBe(WebSocket.OPEN);

      // Independent healthy connection continues working.
      const moveResponse = await sendMoveAndWait(client2, {
        type: "move",
        gameId: "isolation-board-1",
        from: "e2",
        to: "e4",
      });
      expect(moveResponse.type).toBe("move_accepted");
      expect(moveResponse.san).toBe("e4");

      // Server-level WS error is also caught and reported without crashing.
      const serverErr = new Error("simulated wss error");
      expect(() => {
        wss.emit("error", serverErr);
      }).not.toThrow();
      expect(onError).toHaveBeenCalledWith(serverErr, "server");

      // HTTP /health remains healthy.
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      expect(await healthRes.json()).toMatchObject({ status: "ok", wsEnabled: true });
    } finally {
      client1?.terminate();
      client2?.terminate();
      await closeHallServer(server, wss);
    }
  });

  it("contains oversized WebSocket payloads to the offending connection (HALL-02)", async () => {
    const app = createHallApp({ wsEnabled: true });
    const { server, port } = await startHallServer(app);
    const onError = vi.fn<(err: Error, context: "server" | "connection") => void>();
    const wss = attachHallWebSocketServer(server, {
      maxPayloadBytes: 128,
      onError,
    });

    let offendingClient: WebSocket | undefined;
    let healthyClient: WebSocket | undefined;

    try {
      offendingClient = await connectWebSocket(`ws://127.0.0.1:${port}/ws`);
      healthyClient = await connectWebSocket(`ws://127.0.0.1:${port}/ws`);

      // Suppress client-side error event if connection resets after close.
      offendingClient.on("error", () => {});
      const offendingClosed = waitForClose(offendingClient);
      offendingClient.send("x".repeat(512));
      await offendingClosed;

      expect(onError).toHaveBeenCalledWith(expect.any(Error), "connection");
      expect(offendingClient.readyState).toBe(WebSocket.CLOSED);

      const moveResponse = await sendMoveAndWait(healthyClient, {
        type: "move",
        gameId: "payload-limit-board",
        from: "d2",
        to: "d4",
      });
      expect(moveResponse.type).toBe("move_accepted");
      expect(moveResponse.san).toBe("d4");

      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
    } finally {
      offendingClient?.terminate();
      healthyClient?.terminate();
      await closeHallServer(server, wss);
    }
  });
});
