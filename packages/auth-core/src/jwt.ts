import { SessionPayloadSchema, type SessionPayload } from "./types.js";

export interface SessionVerificationResult {
  valid: boolean;
  payload: SessionPayload | null;
  reason?: "invalid_schema" | "expired" | "invalid_signature";
}

/**
 * Validates the structure and expiry of a decoded cross-subdomain session payload.
 * Cryptographic signature verification (HMAC/EdDSA/JWKS) plugs in before calling this helper.
 */
export function validateSessionPayload(
  rawPayload: unknown,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): SessionVerificationResult {
  const parsed = SessionPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    return { valid: false, payload: null, reason: "invalid_schema" };
  }
  if (parsed.data.exp <= nowEpochSeconds) {
    return { valid: false, payload: null, reason: "expired" };
  }
  return { valid: true, payload: parsed.data };
}
