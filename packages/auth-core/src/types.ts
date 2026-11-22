import { z } from "zod";

export const UserRoleSchema = z.enum(["admin", "moderator", "coach", "student"]);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const ProgramRoleSchema = z.enum(["director", "coach", "student"]);
export type ProgramRole = z.infer<typeof ProgramRoleSchema>;

export const SessionPayloadSchema = z.object({
  sub: z.string().uuid(),
  handle: z.string().min(2).max(64),
  role: UserRoleSchema,
  programIds: z.array(z.string().uuid()).default([]),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
});
export type SessionPayload = z.infer<typeof SessionPayloadSchema>;

export const InviteTokenSchema = z.object({
  code: z.string().min(6).max(64),
  assignedRole: UserRoleSchema,
  programId: z.string().uuid().nullable(),
  maxUses: z.number().int().positive(),
  usedCount: z.number().int().nonnegative(),
  expiresAt: z.string().datetime().nullable(),
});
export type InviteToken = z.infer<typeof InviteTokenSchema>;

export const DoubleBlindLinkStatusSchema = z.enum(["pending_unilateral", "active", "revoked"]);
export type DoubleBlindLinkStatus = z.infer<typeof DoubleBlindLinkStatusSchema>;

/**
 * Strictly symmetric response returned by POST /links/intent.
 * MUST NOT leak whether the target handle exists or whether a mutual link activated.
 */
export const OpaqueLinkIntentResponseSchema = z.object({
  accepted: z.literal(true),
  message: z.literal(
    "If both accounts submit matching handles, the link will activate automatically.",
  ),
});
export type OpaqueLinkIntentResponse = z.infer<typeof OpaqueLinkIntentResponseSchema>;

export const OPAQUE_LINK_INTENT_RESPONSE: OpaqueLinkIntentResponse = {
  accepted: true,
  message: "If both accounts submit matching handles, the link will activate automatically.",
};

export function normalizeHandle(rawHandle: string): string {
  return rawHandle.trim().toLowerCase();
}
