import { describe, expect, it } from "vitest";
import {
  canStudentReadStudy,
  computeEffectiveStudentAccess,
  evaluateDoubleBlindLinkTransition,
  validateSessionPayload,
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
});
