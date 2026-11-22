import {
  OPAQUE_LINK_INTENT_RESPONSE,
  evaluateDoubleBlindLinkTransition,
  normalizeHandle,
  type DirectionalLinkIntent,
} from "@suite/auth-core";
import { Hono } from "hono";
import { z } from "zod";

const LinkIntentBodySchema = z.object({
  targetHandle: z.string().min(2).max(64),
});

const InviteCreateBodySchema = z.object({
  assignedRole: z.enum(["admin", "moderator", "coach", "student"]),
  maxUses: z.number().int().positive().default(1),
});

export function createIdApp() {
  const app = new Hono();
  const inMemoryIntents: DirectionalLinkIntent[] = [];

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "id",
      registrationMode: "invite-only",
    }),
  );

  app.post("/invites", async (c) => {
    const body = InviteCreateBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "Invalid invite payload" }, 400);
    }
    return c.json(
      {
        status: "stub",
        message: "Invite issuance endpoint ready for DB persistence via @suite/db.",
        assignedRole: body.data.assignedRole,
        maxUses: body.data.maxUses,
      },
      201,
    );
  });

  app.post("/auth/register", (c) =>
    c.json(
      {
        status: "stub",
        message:
          "Invite-only registration requires a valid single-use or quota-limited invite code.",
      },
      501,
    ),
  );

  app.post("/auth/login", (c) =>
    c.json(
      {
        status: "stub",
        message: "Cross-subdomain session/JWT login stub.",
      },
      501,
    ),
  );

  /**
   * Double-blind linking endpoint.
   * INVARIANT: Always returns HTTP 202 with an identical generic body regardless of whether
   * `targetHandle` exists or whether a mutual link just materialized. Zero notifications emitted.
   */
  app.post("/links/intent", async (c) => {
    const body = LinkIntentBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "Invalid handle format" }, 400);
    }

    const initiatorUserId =
      c.req.header("x-stub-user-id") ?? "00000000-0000-4000-8000-000000000000";
    const initiatorHandle = c.req.header("x-stub-handle") ?? "anonymous_stub";
    const incoming: DirectionalLinkIntent = {
      initiatorUserId,
      initiatorHandle: normalizeHandle(initiatorHandle),
      targetHandle: normalizeHandle(body.data.targetHandle),
    };

    const transition = evaluateDoubleBlindLinkTransition(incoming, inMemoryIntents);
    if (transition.internalStatus === "pending_unilateral") {
      inMemoryIntents.push(incoming);
    }

    return c.json(OPAQUE_LINK_INTENT_RESPONSE, 202);
  });

  return app;
}
