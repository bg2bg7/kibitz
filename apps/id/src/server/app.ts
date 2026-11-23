import {
  BCRYPT_COST,
  OPAQUE_LINK_INTENT_RESPONSE,
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  extractSessionToken,
  hashPassword,
  isAllowedSuiteOrigin,
  resolveAuthConfig,
  signSessionToken,
  verifyPassword,
  verifySessionToken,
  type SessionJwtConfig,
  type SessionPayload,
} from "@suite/auth-core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { InMemoryIdentityRepository, type IdentityRepository } from "./repository.js";

const HANDLE_REGEX = /^[a-zA-Z0-9_-]{2,32}$/;

const LoginBodySchema = z.object({
  handle: z.string().trim().min(2).max(64),
  password: z.string().min(1).max(256),
});

const RegisterBodySchema = z.object({
  inviteCode: z.string().trim().min(4).max(64),
  handle: z
    .string()
    .trim()
    .regex(
      HANDLE_REGEX,
      "Handle must be 2–32 characters using only letters, numbers, underscores, or hyphens (no email addresses).",
    ),
  password: z.string().min(10, "Password must be at least 10 characters.").max(256),
});

const InviteCreateBodySchema = z.object({
  assignedRole: z.enum(["admin", "moderator", "coach", "student"]),
  maxUses: z.number().int().min(1).max(500).default(1),
  programId: z.string().uuid().nullable().optional(),
  expiresInHours: z.number().int().min(1).max(720).nullable().optional(),
});

const LinkIntentBodySchema = z.object({
  targetHandle: z.string().trim().min(2).max(64),
});

export interface CreateIdAppOptions {
  repository?: IdentityRepository;
  authConfig?: SessionJwtConfig;
  bcryptCost?: number;
}

export function createIdApp(options: CreateIdAppOptions = {}) {
  const repository = options.repository ?? new InMemoryIdentityRepository();
  const authConfig = options.authConfig ?? resolveAuthConfig(process.env);
  const bcryptCost = options.bcryptCost ?? BCRYPT_COST;
  const app = new Hono();

  // Strict cross-suite CORS & CSRF Origin check
  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const allowedOrigin = origin && isAllowedSuiteOrigin(origin, authConfig) ? origin : null;

    if (allowedOrigin) {
      c.header("Access-Control-Allow-Origin", allowedOrigin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      c.header("Vary", "Origin");
    }

    if (c.req.method === "OPTIONS") {
      return c.body(null, allowedOrigin ? 204 : 403);
    }

    if (origin && !allowedOrigin && (c.req.method === "POST" || c.req.method === "DELETE")) {
      return c.json({ error: "Origin not allowed." }, 403);
    }

    await next();
  });

  async function authenticateRequest(c: Context): Promise<SessionPayload | null> {
    const cookieHeader = c.req.header("cookie");
    const token = extractSessionToken({
      authorization: c.req.header("authorization"),
      cookie: cookieHeader,
    });
    if (!token) {
      return null;
    }
    const verified = await verifySessionToken(token, authConfig);
    if (!verified.valid || !verified.payload) {
      if (cookieHeader) {
        c.header("Set-Cookie", buildClearSessionCookieHeader(authConfig));
      }
      return null;
    }

    const dbUser = await repository.findUserById(verified.payload.sub);
    if (!dbUser) {
      if (cookieHeader) {
        c.header("Set-Cookie", buildClearSessionCookieHeader(authConfig));
      }
      return null;
    }

    const programIds = await repository.getUserProgramIds(dbUser.id);
    return {
      ...verified.payload,
      handle: dbUser.handle,
      role: dbUser.role,
      programIds,
    };
  }

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "id",
      registrationMode: "invite-only",
    }),
  );

  app.get("/auth/session", async (c) => {
    c.header("Cache-Control", "no-store");
    const user = await authenticateRequest(c);
    if (!user) {
      return c.json({ authenticated: false, user: null });
    }
    return c.json({ authenticated: true, user });
  });

  app.post("/auth/login", async (c) => {
    c.header("Cache-Control", "no-store");
    const parsed = LoginBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Handle and password are required." }, 400);
    }

    const user = await repository.findUserByHandle(parsed.data.handle);
    if (!user) {
      return c.json({ error: "Invalid handle or password." }, 401);
    }

    const passwordOk = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!passwordOk) {
      return c.json({ error: "Invalid handle or password." }, 401);
    }

    const programIds = await repository.getUserProgramIds(user.id);
    const { token, payload } = await signSessionToken(
      {
        sub: user.id,
        handle: user.handle,
        role: user.role,
        programIds,
      },
      authConfig,
    );

    c.header("Set-Cookie", buildSessionCookieHeader(token, authConfig));
    return c.json({ user: payload });
  });

  app.post("/auth/register", async (c) => {
    c.header("Cache-Control", "no-store");
    const parsed = RegisterBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]?.message ?? "Invalid registration payload.";
      return c.json({ error: firstIssue }, 400);
    }

    const passwordHash = await hashPassword(parsed.data.password, bcryptCost);
    const result = await repository.redeemInviteAndCreateUser({
      inviteCode: parsed.data.inviteCode,
      handle: parsed.data.handle,
      passwordHash,
    });

    if (!result.ok) {
      if (result.code === "handle_taken") {
        return c.json({ error: "That handle is already taken." }, 409);
      }
      if (result.code === "invite_expired") {
        return c.json({ error: "This invite code has expired." }, 400);
      }
      if (result.code === "invite_exhausted") {
        return c.json({ error: "This invite code has reached its maximum uses." }, 400);
      }
      return c.json({ error: "Invalid invite code." }, 400);
    }

    const { token, payload } = await signSessionToken(
      {
        sub: result.user.id,
        handle: result.user.handle,
        role: result.user.role,
        programIds: result.programIds,
      },
      authConfig,
    );

    c.header("Set-Cookie", buildSessionCookieHeader(token, authConfig));
    return c.json({ user: payload }, 201);
  });

  app.post("/auth/logout", (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Set-Cookie", buildClearSessionCookieHeader(authConfig));
    return c.json({ ok: true });
  });

  app.post("/invites", async (c) => {
    const session = await authenticateRequest(c);
    if (!session) {
      return c.json({ error: "Authentication required." }, 401);
    }
    if (session.role !== "admin" && session.role !== "coach") {
      return c.json({ error: "Only admins and coaches can issue invite codes." }, 403);
    }

    const parsed = InviteCreateBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid invite payload." }, 400);
    }

    if (session.role === "coach" && parsed.data.assignedRole !== "student") {
      return c.json({ error: "Coaches can only issue student invite codes." }, 403);
    }

    const expiresAt = parsed.data.expiresInHours
      ? new Date(Date.now() + parsed.data.expiresInHours * 60 * 60 * 1000)
      : null;

    const invite = await repository.createInvite({
      createdByUserId: session.sub,
      assignedRole: parsed.data.assignedRole,
      programId: parsed.data.programId ?? null,
      maxUses: parsed.data.maxUses,
      expiresAt,
    });

    return c.json({ invite }, 201);
  });

  app.get("/invites", async (c) => {
    const session = await authenticateRequest(c);
    if (!session) {
      return c.json({ error: "Authentication required." }, 401);
    }
    if (session.role !== "admin" && session.role !== "coach") {
      return c.json({ error: "Only admins and coaches can view invite codes." }, 403);
    }

    const invitesList = await repository.listInvites(
      session.role === "admin" ? undefined : { createdByUserId: session.sub },
    );
    return c.json({ invites: invitesList });
  });

  /**
   * Double-blind linking endpoint.
   * INVARIANT: Always returns HTTP 202 with an identical generic body regardless of whether
   * `targetHandle` exists or whether a mutual link just materialized. Zero notifications emitted.
   */
  app.post("/links/intent", async (c) => {
    const session = await authenticateRequest(c);
    if (!session) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const parsed = LinkIntentBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid handle format." }, 400);
    }

    await repository.submitDoubleBlindLinkIntent({
      initiatorUserId: session.sub,
      initiatorHandle: session.handle,
      targetHandle: parsed.data.targetHandle,
    });

    return c.json(OPAQUE_LINK_INTENT_RESPONSE, 202);
  });

  app.get("/links", async (c) => {
    const session = await authenticateRequest(c);
    if (!session) {
      return c.json({ error: "Authentication required." }, 401);
    }
    const links = await repository.listActiveLinks(session.sub);
    return c.json({ links });
  });

  app.delete("/links/:peerUserId", async (c) => {
    const session = await authenticateRequest(c);
    if (!session) {
      return c.json({ error: "Authentication required." }, 401);
    }
    const peerUserId = c.req.param("peerUserId");
    const revoked = await repository.revokeActiveLink(session.sub, peerUserId);
    if (!revoked) {
      return c.json({ error: "Active link not found." }, 404);
    }
    return c.json({ revoked: true });
  });

  return app;
}
