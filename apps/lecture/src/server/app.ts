import {
  extractSessionToken,
  isAllowedSuiteOrigin,
  resolveAuthConfig,
  verifySessionToken,
  type SessionJwtConfig,
} from "@suite/auth-core";
import { Hono } from "hono";

export interface CreateLectureAppOptions {
  authConfig?: SessionJwtConfig;
}

export function createLectureApp(options: CreateLectureAppOptions = {}) {
  const authConfig = options.authConfig ?? resolveAuthConfig(process.env);
  const app = new Hono();

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const allowedOrigin = origin && isAllowedSuiteOrigin(origin, authConfig) ? origin : null;
    if (allowedOrigin) {
      c.header("Access-Control-Allow-Origin", allowedOrigin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
      service: "lecture",
    }),
  );

  app.get("/api/primers", (c) =>
    c.json({
      visibility: "public_moderated",
      items: [
        {
          id: "primer-italian-800-1200",
          title: "Italian Game Essentials (800-1200 Primer)",
          format: "pgna-v1.0",
          requiresAuth: false,
        },
      ],
    }),
  );

  app.get("/api/assignments", async (c) => {
    const token = extractSessionToken({
      authorization: c.req.header("authorization"),
      cookie: c.req.header("cookie"),
    });
    if (!token) {
      return c.json({ error: "Authentication required for coach assignments." }, 401);
    }
    const verified = await verifySessionToken(token, authConfig);
    if (!verified.valid || !verified.payload) {
      return c.json({ error: "Invalid or expired Kibitz ID session." }, 401);
    }
    return c.json({
      viewer: {
        sub: verified.payload.sub,
        handle: verified.payload.handle,
        role: verified.payload.role,
      },
      items: [],
      interactionPolicy: "emoji_only",
    });
  });

  return app;
}
