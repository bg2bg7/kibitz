import { describe, expect, it } from "vitest";
import {
  BCRYPT_MAX_PASSWORD_BYTES,
  DEFAULT_DEV_JWT_SECRET,
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  canIssueProgramInvite,
  canPublishToProgram,
  canStudentReadStudy,
  computeEffectiveStudentAccess,
  evaluateDoubleBlindLinkTransition,
  extractSessionToken,
  getPasswordByteLength,
  hasProgramStaffMembership,
  hashPassword,
  isAllowedSuiteOrigin,
  isPlaceholderJwtSecret,
  isWithinBcryptByteLimit,
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

  it("rejects default, placeholder, and short JWT secrets in production while accepting generated random secrets", () => {
    expect(isPlaceholderJwtSecret(DEFAULT_DEV_JWT_SECRET)).toBe(true);
    expect(
      isPlaceholderJwtSecret("replace-me-with-something-long-enough-to-pass-32-chars"),
    ).toBe(true);
    expect(isPlaceholderJwtSecret("dev-only-secret-that-is-32-characters-long")).toBe(true);
    expect(isPlaceholderJwtSecret("  CHANGE-ME-secret-with-extra-characters-here  ")).toBe(true);
    expect(isPlaceholderJwtSecret("my-changeme-secret-long-enough-for-32-bytes")).toBe(true);
    expect(isPlaceholderJwtSecret("this-is-a-placeholder-secret-value-123456")).toBe(true);
    expect(isPlaceholderJwtSecret("your-secret-key-goes-here-at-least-32-bytes")).toBe(true);
    expect(isPlaceholderJwtSecret("example-secret-value-copied-from-docs-1234")).toBe(true);
    expect(
      isPlaceholderJwtSecret("k9F2mQ8xR4pL7wV1nB6cT3yH5jD0sA8eU2zN4qW6vM9pK1rX3bG7tJ5cL8hF0dY2"),
    ).toBe(false);

    // Rejects bundled dev default in production
    expect(() =>
      resolveAuthConfig({
        NODE_ENV: "production",
        AUTH_JWT_SECRET: DEFAULT_DEV_JWT_SECRET,
      }),
    ).toThrow(/placeholder|default/i);

    // Rejects placeholder secrets in production even when >= 32 bytes
    for (const badSecret of [
      "replace-me-with-something-long-enough-to-pass-32-chars",
      "dev-only-secret-that-is-32-characters-long",
      "change-me-to-something-unique-and-long-enough",
      "this-placeholder-secret-must-be-rejected-in-prod",
    ]) {
      expect(() =>
        resolveAuthConfig({
          NODE_ENV: "production",
          AUTH_JWT_SECRET: badSecret,
        }),
      ).toThrow(/openssl rand/i);
    }

    // Rejects missing or < 32 UTF-8 byte secrets in production
    expect(() => resolveAuthConfig({ NODE_ENV: "production" })).toThrow(/32 UTF-8 bytes/i);
    expect(() =>
      resolveAuthConfig({
        NODE_ENV: "production",
        AUTH_JWT_SECRET: "x".repeat(31),
      }),
    ).toThrow(/32 UTF-8 bytes/i);

    // Accepts a real generated random secret in production
    const realSecret = "k9F2mQ8xR4pL7wV1nB6cT3yH5jD0sA8eU2zN4qW6vM9pK1rX3bG7tJ5cL8hF0dY2";
    const prodCfg = resolveAuthConfig({
      NODE_ENV: "production",
      AUTH_JWT_SECRET: realSecret,
    });
    expect(prodCfg.secret).toBe(realSecret);
    expect(prodCfg.secureCookie).toBe(true);
  });

  it("enforces bcrypt's 72-byte UTF-8 boundary on hashPassword while keeping verifyPassword non-throwing", async () => {
    expect(BCRYPT_MAX_PASSWORD_BYTES).toBe(72);

    // Exact 72 ASCII bytes succeeds and verifies
    const ascii72 = "a".repeat(72);
    expect(getPasswordByteLength(ascii72)).toBe(72);
    expect(isWithinBcryptByteLimit(ascii72)).toBe(true);
    const ascii72Hash = await hashPassword(ascii72, 4);
    expect(await verifyPassword(ascii72, ascii72Hash)).toBe(true);

    // 73 ASCII bytes throws
    const ascii73 = "a".repeat(73);
    expect(getPasswordByteLength(ascii73)).toBe(73);
    expect(isWithinBcryptByteLimit(ascii73)).toBe(false);
    await expect(hashPassword(ascii73, 4)).rejects.toThrow(/72-byte UTF-8 limit/);

    // Exact 72 UTF-8 bytes using 4-byte emoji (18 * 4 = 72) succeeds and verifies
    const emoji72 = "🔑".repeat(18);
    expect(getPasswordByteLength(emoji72)).toBe(72);
    expect(isWithinBcryptByteLimit(emoji72)).toBe(true);
    const emoji72Hash = await hashPassword(emoji72, 4);
    expect(await verifyPassword(emoji72, emoji72Hash)).toBe(true);

    // 76 UTF-8 bytes using 4-byte emoji (19 * 4 = 76) throws
    const emoji76 = "🔑".repeat(19);
    expect(getPasswordByteLength(emoji76)).toBe(76);
    expect(isWithinBcryptByteLimit(emoji76)).toBe(false);
    await expect(hashPassword(emoji76, 4)).rejects.toThrow(/72-byte UTF-8 limit/);

    // Exact 72 UTF-8 bytes using 3-byte euro signs (24 * 3 = 72) succeeds; 25 (75 bytes) throws
    const euro72 = "€".repeat(24);
    expect(getPasswordByteLength(euro72)).toBe(72);
    expect(isWithinBcryptByteLimit(euro72)).toBe(true);
    const euro72Hash = await hashPassword(euro72, 4);
    expect(await verifyPassword(euro72, euro72Hash)).toBe(true);

    const euro75 = "€".repeat(25);
    expect(getPasswordByteLength(euro75)).toBe(75);
    expect(isWithinBcryptByteLimit(euro75)).toBe(false);
    await expect(hashPassword(euro75, 4)).rejects.toThrow(/72-byte UTF-8 limit/);

    // verifyPassword remains non-throwing for legacy/overlong inputs
    await expect(verifyPassword(`${ascii72}extra-legacy-suffix`, ascii72Hash)).resolves.toBe(true);
    await expect(verifyPassword("b".repeat(100), ascii72Hash)).resolves.toBe(false);
  });

  it("enforces shared program invite and program publish authority across roles and programs", () => {
    const progA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const progB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const adminId = "00000000-0000-4000-8000-000000000001";
    const coachA = "00000000-0000-4000-8000-000000000002";
    const modId = "00000000-0000-4000-8000-000000000003";
    const studentId = "00000000-0000-4000-8000-000000000004";

    const memberships = [
      { programId: progA, userId: coachA, role: "coach" as const },
      { programId: progB, userId: coachA, role: "student" as const },
      { programId: progA, userId: studentId, role: "student" as const },
      { programId: progA, userId: modId, role: "director" as const },
    ];

    expect(hasProgramStaffMembership(coachA, progA, memberships)).toBe(true);
    expect(hasProgramStaffMembership(coachA, progB, memberships)).toBe(false);

    // Program invites (ID-01)
    expect(canIssueProgramInvite({ id: adminId, role: "admin" }, progB, "coach", [])).toBe(true);
    expect(canIssueProgramInvite({ id: coachA, role: "coach" }, progA, "student", memberships)).toBe(true);
    expect(canIssueProgramInvite({ id: coachA, role: "coach" }, progA, "coach", memberships)).toBe(false);
    expect(canIssueProgramInvite({ id: coachA, role: "coach" }, progB, "student", memberships)).toBe(false);
    expect(canIssueProgramInvite({ id: modId, role: "moderator" }, progA, "student", memberships)).toBe(false);
    expect(canIssueProgramInvite({ id: studentId, role: "student" }, progA, "student", memberships)).toBe(false);

    // Program publishing (LEC-02): strictly admins and program-authorized coaches only
    expect(canPublishToProgram({ id: adminId, role: "admin" }, progB, [])).toBe(true);
    expect(canPublishToProgram({ id: coachA, role: "coach" }, progA, memberships)).toBe(true);
    expect(canPublishToProgram({ id: coachA, role: "coach" }, progB, memberships)).toBe(false);
    expect(canPublishToProgram({ id: modId, role: "moderator" }, progA, memberships)).toBe(false);
    expect(canPublishToProgram({ id: studentId, role: "student" }, progA, memberships)).toBe(false);
  });

  it("returns null instead of throwing when session cookie contains malformed percent-encoding (ID-05)", () => {
    expect(parseSessionCookie("kibitz_session=%E0%A4%A")).toBeNull();
    expect(parseSessionCookie("foo=1; kibitz_session=%ZZ; bar=2")).toBeNull();
    expect(extractSessionToken({ cookie: "kibitz_session=%E0%A4%A" })).toBeNull();
  });
});

