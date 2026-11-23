import {
  extractSessionToken,
  isAllowedSuiteOrigin,
  resolveAuthConfig,
  verifySessionToken,
  type SessionJwtConfig,
} from "@suite/auth-core";
import { ChessPosition, INITIAL_FEN } from "@suite/chess-core";
import { Hono } from "hono";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type { Server as HttpServer } from "node:http";

export const DEFAULT_HALL_WS_MAX_PAYLOAD_BYTES = 4096;
export const DEFAULT_HALL_WS_MAX_GAMES = 256;

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
 * Determines whether Hall's live WebSocket move channel (/ws) should be enabled.
 *
 * Disabled by default (HALL-01) and unconditionally disabled in production because
 * seat, authentication, and tournament schedule enforcement are not implemented yet.
 * Outside production, developers may opt in explicitly with HALL_ENABLE_DEV_WS=true.
 */
export function isHallWebSocketEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env["NODE_ENV"]?.trim().toLowerCase() === "production") {
    return false;
  }
  return env["HALL_ENABLE_DEV_WS"]?.trim().toLowerCase() === "true";
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

/**
 * Pure WebSocket move validator using @suite/chess-core.
 * Strictly scheduled club tournament games only — no open lobby, no matchmaking, no chat.
 */
export function handleTournamentMoveMessage(
  rawPayload: string,
  positionByGameId: Map<string, ChessPosition>,
  maxGames: number = DEFAULT_HALL_WS_MAX_GAMES,
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
  const existingPosition = positionByGameId.get(gameId);
  if (!existingPosition && positionByGameId.size >= maxGames) {
    return {
      type: "move_rejected",
      gameId,
      fen: INITIAL_FEN,
      reason: `Tournament room capacity reached (max ${maxGames} active games).`,
    };
  }

  const position = existingPosition ?? new ChessPosition(INITIAL_FEN);
  const applied = position.tryMove(promotion ? { from, to, promotion } : { from, to });
  if (!applied) {
    return {
      type: "move_rejected",
      gameId,
      fen: position.fen,
      reason: `Illegal move: ${from}${to}`,
    };
  }

  if (!existingPosition) {
    positionByGameId.set(gameId, position);
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
  wsEnabled?: boolean;
}

export function createHallApp(options: CreateHallAppOptions = {}) {
  const authConfig = options.authConfig ?? resolveAuthConfig(process.env);
  const wsEnabled = options.wsEnabled ?? isHallWebSocketEnabled(process.env);
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
      wsEnabled,
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

export interface AttachHallWebSocketOptions {
  maxPayloadBytes?: number;
  maxGames?: number;
  onError?: (err: Error, context: "server" | "connection") => void;
}

export function attachHallWebSocketServer(
  httpServer: HttpServer,
  options: AttachHallWebSocketOptions = {},
): WebSocketServer {
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_HALL_WS_MAX_PAYLOAD_BYTES;
  const maxGames = options.maxGames ?? DEFAULT_HALL_WS_MAX_GAMES;
  const onError =
    options.onError ??
    ((err: Error, context: "server" | "connection") => {
      console.error(`[hall] WebSocket ${context} error:`, err.message);
    });

  const reportError = (err: unknown, context: "server" | "connection") => {
    const normalized = err instanceof Error ? err : new Error(String(err));
    onError(normalized, context);
  };

  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: maxPayloadBytes,
  });
  const positionByGameId = new Map<string, ChessPosition>();

  wss.on("error", (err) => {
    reportError(err, "server");
  });

  wss.on("connection", (socket: WebSocket) => {
    const containConnectionError = (err: unknown) => {
      reportError(err, "connection");
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    };

    socket.on("error", (err) => {
      containConnectionError(err);
    });

    socket.on("message", (data) => {
      try {
        const response = handleTournamentMoveMessage(
          rawDataToString(data),
          positionByGameId,
          maxGames,
        );
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(response), (sendErr) => {
            if (sendErr) {
              containConnectionError(sendErr);
            }
          });
        }
      } catch (err) {
        containConnectionError(err);
      }
    });
  });

  return wss;
}
