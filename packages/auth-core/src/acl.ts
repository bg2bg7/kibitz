import {
  OPAQUE_LINK_INTENT_RESPONSE,
  normalizeHandle,
  type DoubleBlindLinkStatus,
  type OpaqueLinkIntentResponse,
} from "./types.js";

export interface CoachStudentLinkRecord {
  coachUserId: string;
  studentUserId: string;
  revokedAt: string | null;
}

export interface ProgramMembershipRecord {
  programId: string;
  userId: string;
  role: "director" | "coach" | "student";
}

export interface StudyAccessDescriptor {
  id: string;
  ownerUserId: string;
  programId: string | null;
  visibility: "public_moderated" | "coach_students" | "program" | "private";
  moderationStatus: "pending" | "approved" | "rejected";
}

export interface EffectiveStudentAccess {
  studentUserId: string;
  activeCoachIds: ReadonlySet<string>;
  programIds: ReadonlySet<string>;
  canAccessPublicModerated: true;
}

/**
 * Computes a student's effective library access as the union of:
 * 1. All active (non-revoked) multi-coach links
 * 2. All school/program memberships
 * 3. Public moderated library studies
 */
export function computeEffectiveStudentAccess(
  studentUserId: string,
  coachLinks: readonly CoachStudentLinkRecord[],
  programMemberships: readonly ProgramMembershipRecord[],
): EffectiveStudentAccess {
  const activeCoachIds = new Set<string>();
  for (const link of coachLinks) {
    if (link.studentUserId === studentUserId && link.revokedAt === null) {
      activeCoachIds.add(link.coachUserId);
    }
  }

  const programIds = new Set<string>();
  for (const membership of programMemberships) {
    if (membership.userId === studentUserId) {
      programIds.add(membership.programId);
    }
  }

  return {
    studentUserId,
    activeCoachIds,
    programIds,
    canAccessPublicModerated: true,
  };
}

/**
 * Evaluates whether a student can read a specific study under their effective union ACL.
 */
export function canStudentReadStudy(
  access: EffectiveStudentAccess,
  study: StudyAccessDescriptor,
): boolean {
  if (study.visibility === "public_moderated" && study.moderationStatus === "approved") {
    return true;
  }
  if (study.visibility === "coach_students" && access.activeCoachIds.has(study.ownerUserId)) {
    return true;
  }
  if (
    study.visibility === "program" &&
    study.programId !== null &&
    access.programIds.has(study.programId)
  ) {
    return true;
  }
  return false;
}

export interface DirectionalLinkIntent {
  initiatorUserId: string;
  initiatorHandle: string;
  targetHandle: string;
}

export interface DoubleBlindTransitionResult {
  /** Internal server state transition; NEVER exposed directly to API callers. */
  internalStatus: DoubleBlindLinkStatus;
  materializedPair: { userAId: string; userBId: string } | null;
  /** Strictly identical public response regardless of whether target handle exists or matched. */
  publicResponse: OpaqueLinkIntentResponse;
}

/**
 * Pure state-transition evaluator for double-blind account linking.
 * A link becomes `active` ONLY when mutually matching directional intents exist.
 * The returned `publicResponse` is ALWAYS identical to avoid handle-existence leakage.
 */
export function evaluateDoubleBlindLinkTransition(
  incoming: DirectionalLinkIntent,
  existingPendingIntents: readonly DirectionalLinkIntent[],
): DoubleBlindTransitionResult {
  const normalizedInitiator = normalizeHandle(incoming.initiatorHandle);
  const normalizedTarget = normalizeHandle(incoming.targetHandle);

  const reciprocal = existingPendingIntents.find(
    (intent) =>
      intent.initiatorUserId !== incoming.initiatorUserId &&
      normalizeHandle(intent.initiatorHandle) === normalizedTarget &&
      normalizeHandle(intent.targetHandle) === normalizedInitiator,
  );

  if (reciprocal) {
    return {
      internalStatus: "active",
      materializedPair: {
        userAId: reciprocal.initiatorUserId,
        userBId: incoming.initiatorUserId,
      },
      publicResponse: OPAQUE_LINK_INTENT_RESPONSE,
    };
  }

  return {
    internalStatus: "pending_unilateral",
    materializedPair: null,
    publicResponse: OPAQUE_LINK_INTENT_RESPONSE,
  };
}
