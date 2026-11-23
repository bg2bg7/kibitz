import {
  extractSessionToken,
  isAllowedSuiteOrigin,
  resolveAuthConfig,
  verifySessionToken,
  type SessionJwtConfig,
} from "@suite/auth-core";
import { ChessPosition, INITIAL_FEN } from "@suite/chess-core";
import { Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { Server as HttpServer } from "node:http";

const MoveMessageSchema = z.object({
  type: z.literal("move"),
  gameId: z.string().min(1),
  from: z.string().length(2),
  to: z.string().length(2),
  promotion: z.enum(["q", "r", "b", "n"]).optional(),
});

export interface MoveValidationResponse {
  type: "move_accepted" | "move_rejected";
  gameId: string;
  fen: string;
  san?: string;
  reason?: string;
}

/**
 * Pure WebSocket move validator using @suite/chess-core.
 * Strictly scheduled club tournament games only — no open lobby, no matchmaking, no chat.
 */
export function handleTournamentMoveMessage(
  rawPayload: string,
  positionByGameId: Map<string, ChessPosition>,
): MoveValidationResponse {
  let json: unknown;
  try {
    json = JSON.parse(rawPayload);
  } catch {
    return {
      type: "move_rejected",
      gameId: "",
      fen: INITIAL_FEN,
      reason: "Invalid JSON message.",
    };
  }

  const parsed = MoveMessageSchema.safeParse(json);
  if (!parsed.success) {
    return {
      type: "move_rejected",
      gameId: "",
      fen: INITIAL_FEN,
      reason: "Unsupported message schema (only scheduled tournament moves are accepted).",
    };
  }

  const { gameId, from, to, promotion } = parsed.data;
  let position = positionByGameId.get(gameId);
  if (!position) {
    position = new ChessPosition(INITIAL_FEN);
    positionByGameId.set(gameId, position);
  }

  const applied = position.tryMove(promotion ? { from, to, promotion } : { from, to });
  if (!applied) {
    return {
      type: "move_rejected",
      gameId,
      fen: position.fen,
      reason: `Illegal move: ${from}${to}`,
    };
  }

  return {
    type: "move_accepted",
    gameId,
    fen: applied.fen,
    san: applied.san,
  };
}

export interface CreateHallAppOptions {
  authConfig?: SessionJwtConfig;
}

export function createHallApp(options: CreateHallAppOptions = {}) {
  const authConfig = options.authConfig ?? resolveAuthConfig(process.env);
  const app = new Hono();

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const allowedOrigin = origin && isAllowedSuiteOrigin(origin, authConfig) ? origin : null;
    if (allowedOrigin) {
      c.header("Access-Control-Allow-Origin", allowedOrigin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      c.header("Vary", "Origin");
    }
    if (c.req.method === "OPTIONS") {
      return c.body(null, allowedOrigin ? 204 : 403);
    }
    await next();
  });

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "hall",
      mode: "scheduled-club-tournaments-only",
      openLobby: false,
      chatEnabled: false,
    }),
  );

  /**
   * Read-only tournament feed pullable via shared KibitzID session cookie (including by
   * offline-first PWAs such as Arbiter, which pull tournament metadata without uploading PII).
   */
  app.get("/api/tournaments", async (c) => {
    const token = extractSessionToken({
      authorization: c.req.header("authorization"),
      cookie: c.req.header("cookie"),
    });
    if (!token) {
      return c.json({ error: "Kibitz ID sign-in required to pull scheduled tournaments." }, 401);
    }
    const verified = await verifySessionToken(token, authConfig);
    if (!verified.valid || !verified.payload) {
      return c.json({ error: "Invalid or expired Kibitz ID session." }, 401);
    }
    return c.json({
      mode: "read_only_pull",
      viewer: {
        sub: verified.payload.sub,
        handle: verified.payload.handle,
        role: verified.payload.role,
      },
      items: [],
    });
  });

  return app;
}

export function attachHallWebSocketServer(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  const positionByGameId = new Map<string, ChessPosition>();

  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (data) => {
      const response = handleTournamentMoveMessage(data.toString(), positionByGameId);
      socket.send(JSON.stringify(response));
    });
  });

  return wss;
}
