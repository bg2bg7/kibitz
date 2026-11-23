import { describe, expect, it } from "vitest";
import {
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  canStudentReadStudy,
  computeEffectiveStudentAccess,
  evaluateDoubleBlindLinkTransition,
  extractSessionToken,
  hashPassword,
  isAllowedSuiteOrigin,
  parseSessionCookie,
  resolveAuthConfig,
  signSessionToken,
  validateSessionPayload,
  verifyPassword,
  verifySessionToken,
} from "./index.js";

describe("@suite/auth-core ACL & double-blind invariants", () => {
  it("computes effective student library access as the union of multiple coaches, programs, and public studies", () => {
    const studentId = "11111111-1111-4111-8111-111111111111";
    const coachA = "22222222-2222-4222-8222-222222222222";
    const coachB = "33333333-3333-4333-8333-333333333333";
    const revokedCoach = "44444444-4444-4444-8444-444444444444";
    const programId = "55555555-5555-4555-8555-555555555555";

    const access = computeEffectiveStudentAccess(
      studentId,
      [
        { coachUserId: coachA, studentUserId: studentId, revokedAt: null },
        { coachUserId: coachB, studentUserId: studentId, revokedAt: null },
        {
          coachUserId: revokedCoach,
          studentUserId: studentId,
          revokedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      [{ programId, userId: studentId, role: "student" }],
    );

    expect(
      canStudentReadStudy(access, {
        id: "s-public",
        ownerUserId: "99999999-9999-4999-8999-999999999999",
        programId: null,
        visibility: "public_moderated",
        moderationStatus: "approved",
      }),
    ).toBe(true);

    expect(
      canStudentReadStudy(access, {
        id: "s-public-pending",
        ownerUserId: "99999999-9999-4999-8999-999999999999",
        programId: null,
        visibility: "public_moderated",
        moderationStatus: "pending",
      }),
    ).toBe(false);

    expect(
      canStudentReadStudy(access, {
        id: "s-coach-a",
        ownerUserId: coachA,
        programId: null,
        visibility: "coach_students",
        moderationStatus: "approved",
      }),
    ).toBe(true);

    expect(
      canStudentReadStudy(access, {
        id: "s-coach-b",
        ownerUserId: coachB,
        programId: null,
        visibility: "coach_students",
        moderationStatus: "approved",
      }),
    ).toBe(true);

    expect(
      canStudentReadStudy(access, {
        id: "s-revoked",
        ownerUserId: revokedCoach,
        programId: null,
        visibility: "coach_students",
        moderationStatus: "approved",
      }),
    ).toBe(false);

    expect(
      canStudentReadStudy(access, {
        id: "s-program",
        ownerUserId: revokedCoach,
        programId,
        visibility: "program",
        moderationStatus: "approved",
      }),
    ).toBe(true);
  });

  it("activates double-blind links only on reciprocal intent while returning identical public responses", () => {
    const coachIntent = {
      initiatorUserId: "coach-1",
      initiatorHandle: "CoachAlice",
      targetHandle: "student_bob",
    };

    const unilateral = evaluateDoubleBlindLinkTransition(coachIntent, []);
    expect(unilateral.internalStatus).toBe("pending_unilateral");
    expect(unilateral.materializedPair).toBeNull();

    const reciprocal = evaluateDoubleBlindLinkTransition(
      {
        initiatorUserId: "student-1",
        initiatorHandle: "STUDENT_BOB",
        targetHandle: "coachalice",
      },
      [coachIntent],
    );
    expect(reciprocal.internalStatus).toBe("active");
    expect(reciprocal.materializedPair).toEqual({
      userAId: "coach-1",
      userBId: "student-1",
    });

    // Public response symmetry: zero handle-existence or match leakage.
    expect(unilateral.publicResponse).toEqual(reciprocal.publicResponse);
  });

  it("validates session payload schemas and expiry", () => {
    const valid = validateSessionPayload(
      {
        sub: "11111111-1111-4111-8111-111111111111",
        handle: "coach_alice",
        role: "coach",
        programIds: [],
        iat: 1000,
        exp: 2000,
      },
      1500,
    );
    expect(valid.valid).toBe(true);

    const expired = validateSessionPayload(
      {
        sub: "11111111-1111-4111-8111-111111111111",
        handle: "coach_alice",
        role: "coach",
        programIds: [],
        iat: 1000,
        exp: 1200,
      },
      1500,
    );
    expect(expired.valid).toBe(false);
    expect(expired.reason).toBe("expired");
  });

  it("signs and verifies HS256 cross-service JWTs and rejects tampering, wrong audience, and expiry", async () => {
    const config = resolveAuthConfig({
      AUTH_JWT_SECRET: "super-secret-key-for-unit-tests-at-least-32-chars",
      AUTH_JWT_ISSUER: "id.kibitz.test",
      AUTH_JWT_AUDIENCE: "kibitz-suite",
      AUTH_SESSION_TTL_SECONDS: "3600",
    });

    const { token, payload } = await signSessionToken(
      {
        sub: "11111111-1111-4111-8111-111111111111",
        handle: "coach_alice",
        role: "coach",
        programIds: ["55555555-5555-4555-8555-555555555555"],
      },
      config,
      1000,
    );

    const verified = await verifySessionToken(token, config, 1500);
    expect(verified).toEqual({ valid: true, payload });

    const expired = await verifySessionToken(token, config, 5000);
    expect(expired).toEqual({ valid: false, payload: null, reason: "expired" });

    const wrongAudience = await verifySessionToken(
      token,
      { ...config, audience: "other-suite" },
      1500,
    );
    expect(wrongAudience).toEqual({ valid: false, payload: null, reason: "invalid_claims" });

    const tampered = `${token.slice(0, -2)}aa`;
    const tamperedRes = await verifySessionToken(tampered, config, 1500);
    expect(tamperedRes.valid).toBe(false);
    expect(tamperedRes.reason).toBe("invalid_signature");
  });

  it("builds cross-subdomain cookies, parses tokens, and validates suite origins", () => {
    const localCfg = resolveAuthConfig({ AUTH_COOKIE_DOMAIN: "localhost" });
    const localCookie = buildSessionCookieHeader("tok.en.sig", localCfg);
    expect(localCookie).toContain("kibitz_session=tok.en.sig");
    expect(localCookie).toContain("HttpOnly");
    expect(localCookie).toContain("SameSite=Lax");
    expect(localCookie).not.toContain("Domain=");
    expect(localCookie).not.toContain("Secure");

    const prodCfg = resolveAuthConfig({
      NODE_ENV: "production",
      AUTH_JWT_SECRET: "a-very-strong-production-secret-of-over-32-bytes",
      AUTH_COOKIE_DOMAIN: "kibitz.org",
    });
    const prodCookie = buildSessionCookieHeader("tok.en.sig", prodCfg);
    expect(prodCookie).toContain("Domain=.kibitz.org");
    expect(prodCookie).toContain("Secure");

    const cleared = buildClearSessionCookieHeader(prodCfg);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Domain=.kibitz.org");

    expect(parseSessionCookie("other=1; kibitz_session=abc.def.ghi; foo=bar")).toBe("abc.def.ghi");
    expect(
      extractSessionToken({ authorization: "Bearer bearer.jwt.tok", cookie: "kibitz_session=x" }),
    ).toBe("bearer.jwt.tok");
    expect(extractSessionToken({ cookie: "kibitz_session=cookie.jwt.tok" })).toBe("cookie.jwt.tok");

    expect(isAllowedSuiteOrigin("http://localhost:5170", localCfg)).toBe(true);
    expect(isAllowedSuiteOrigin("http://localhost:5175", localCfg)).toBe(true);
    expect(isAllowedSuiteOrigin("https://evil.example.com", localCfg)).toBe(false);
    expect(isAllowedSuiteOrigin("https://kibitz.org", prodCfg)).toBe(true);
    expect(isAllowedSuiteOrigin("https://arbiter.kibitz.org", prodCfg)).toBe(true);
    expect(isAllowedSuiteOrigin("https://unknown.kibitz.org", prodCfg)).toBe(false);
  });

  it("hashes and verifies bcrypt passwords compatible with Postgres pgcrypto", async () => {
    const hash = await hashPassword("correct-horse-battery-staple", 4);
    expect(hash.startsWith("$2")).toBe(true);
    expect(await verifyPassword("correct-horse-battery-staple", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });
});
