import { randomBytes, randomUUID } from "node:crypto";
import {
  canIssueProgramInvite,
  normalizeHandle,
  type ProgramMembershipRecord,
  type ProgramRole,
  type UserRole,
} from "@suite/auth-core";
import {
  and,
  coachStudentLinks,
  desc,
  eq,
  gt,
  invites,
  isNull,
  linkIntents,
  lt,
  or,
  programMemberships,
  programs,
  sql,
  users,
  type SuiteDatabase,
} from "@suite/db";

export interface UserRecord {
  id: string;
  handle: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
}

export interface ProgramRecord {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
}

export interface InviteRecord {
  code: string;
  createdByUserId: string;
  assignedRole: UserRole;
  programId: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface ActiveLinkRecord {
  peerUserId: string;
  peerHandle: string;
  peerRole: UserRole;
  relation: "coach" | "student";
  createdAt: string;
}

export type InviteEligibilityResult =
  | { ok: true }
  | {
      ok: false;
      code: "invalid_invite" | "invite_exhausted" | "invite_expired";
    };

export type RedeemInviteResult =
  | { ok: true; user: UserRecord; programIds: string[] }
  | {
      ok: false;
      code: "invalid_invite" | "invite_exhausted" | "invite_expired" | "handle_taken";
    };

export interface IdentityRepository {
  readonly storageKind: "postgres" | "memory";
  findUserByHandle(handle: string): Promise<UserRecord | null>;
  findUserById(userId: string): Promise<UserRecord | null>;
  getUserProgramIds(userId: string): Promise<string[]>;
  getUserProgramMemberships(userId: string): Promise<ProgramMembershipRecord[]>;
  programExists(programId: string): Promise<boolean>;
  createInvite(input: {
    createdByUserId: string;
    assignedRole: UserRole;
    programId?: string | null;
    maxUses: number;
    expiresAt?: Date | null;
  }): Promise<InviteRecord>;
  listInvites(filter?: { createdByUserId?: string }): Promise<InviteRecord[]>;
  checkInviteEligibility(inviteCode: string): Promise<InviteEligibilityResult>;
  redeemInviteAndCreateUser(input: {
    inviteCode: string;
    handle: string;
    passwordHash: string;
  }): Promise<RedeemInviteResult>;
  submitDoubleBlindLinkIntent(input: {
    initiatorUserId: string;
    initiatorHandle: string;
    targetHandle: string;
  }): Promise<"pending_unilateral" | "active">;
  listActiveLinks(userId: string): Promise<ActiveLinkRecord[]>;
  revokeActiveLink(userId: string, peerUserId: string): Promise<boolean>;
}

class HandleTakenAbortError extends Error {
  constructor() {
    super("Handle already taken");
    this.name = "HandleTakenAbortError";
  }
}

function isPostgresUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const obj = err as { code?: unknown; cause?: unknown };
  if (obj.code === "23505") {
    return true;
  }
  if (obj.cause && typeof obj.cause === "object") {
    return (obj.cause as { code?: unknown }).code === "23505";
  }
  return false;
}

function toProgramRole(role: UserRole): ProgramRole {
  if (role === "student") return "student";
  if (role === "coach") return "coach";
  return "director";
}

function canonicalHandlePairLockKey(handleA: string, handleB: string): string {
  const [first, second] = [normalizeHandle(handleA), normalizeHandle(handleB)].sort();
  return `${first}\0${second}`;
}

function generateInviteCode(): string {
  const raw = randomBytes(9)
    .toString("base64url")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const padded = (raw + randomBytes(6).toString("hex").toUpperCase()).slice(0, 12);
  return `KBZ-${padded.slice(0, 4)}-${padded.slice(4, 8)}-${padded.slice(8, 12)}`;
}

function resolveCoachStudentPair(
  userA: { id: string; role: UserRole },
  userB: { id: string; role: UserRole },
): { coachUserId: string; studentUserId: string } | null {
  if (userA.id === userB.id) {
    return null;
  }
  if (userA.role === "student" && userB.role !== "student") {
    return { coachUserId: userB.id, studentUserId: userA.id };
  }
  if (userB.role === "student" && userA.role !== "student") {
    return { coachUserId: userA.id, studentUserId: userB.id };
  }
  return null;
}

/**
 * PostgreSQL-backed identity repository using `@suite/db` Drizzle ORM tables.
 */
export class PostgresIdentityRepository implements IdentityRepository {
  readonly storageKind = "postgres" as const;

  constructor(private readonly db: SuiteDatabase) {}

  async findUserByHandle(handle: string): Promise<UserRecord | null> {
    const normalized = normalizeHandle(handle);
    const [row] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.handle}) = ${normalized}`)
      .limit(1);

    if (!row) return null;
    return {
      id: row.id,
      handle: row.handle,
      passwordHash: row.passwordHash,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async findUserById(userId: string): Promise<UserRecord | null> {
    const [row] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!row) return null;
    return {
      id: row.id,
      handle: row.handle,
      passwordHash: row.passwordHash,
      role: row.role,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async getUserProgramIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ programId: programMemberships.programId })
      .from(programMemberships)
      .where(eq(programMemberships.userId, userId));
    return rows.map((row) => row.programId);
  }

  async getUserProgramMemberships(userId: string): Promise<ProgramMembershipRecord[]> {
    const rows = await this.db
      .select({
        programId: programMemberships.programId,
        userId: programMemberships.userId,
        role: programMemberships.role,
      })
      .from(programMemberships)
      .where(eq(programMemberships.userId, userId));
    return rows.map((row) => ({
      programId: row.programId,
      userId: row.userId,
      role: row.role,
    }));
  }

  async programExists(programId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: programs.id })
      .from(programs)
      .where(eq(programs.id, programId))
      .limit(1);
    return Boolean(row);
  }

  async createInvite(input: {
    createdByUserId: string;
    assignedRole: UserRole;
    programId?: string | null;
    maxUses: number;
    expiresAt?: Date | null;
  }): Promise<InviteRecord> {
    const code = generateInviteCode();
    const [inserted] = await this.db
      .insert(invites)
      .values({
        code,
        createdByUserId: input.createdByUserId,
        assignedRole: input.assignedRole,
        programId: input.programId ?? null,
        maxUses: input.maxUses,
        expiresAt: input.expiresAt ?? null,
      })
      .returning();

    if (!inserted) {
      throw new Error("Failed to insert invite record.");
    }

    return {
      code: inserted.code,
      createdByUserId: inserted.createdByUserId,
      assignedRole: inserted.assignedRole,
      programId: inserted.programId,
      maxUses: inserted.maxUses,
      usedCount: inserted.usedCount,
      expiresAt: inserted.expiresAt ? inserted.expiresAt.toISOString() : null,
      createdAt: inserted.createdAt.toISOString(),
    };
  }

  async listInvites(filter?: { createdByUserId?: string }): Promise<InviteRecord[]> {
    const rows = filter?.createdByUserId
      ? await this.db
          .select()
          .from(invites)
          .where(eq(invites.createdByUserId, filter.createdByUserId))
          .orderBy(desc(invites.createdAt))
      : await this.db.select().from(invites).orderBy(desc(invites.createdAt));

    return rows.map((row) => ({
      code: row.code,
      createdByUserId: row.createdByUserId,
      assignedRole: row.assignedRole,
      programId: row.programId,
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async checkInviteEligibility(inviteCode: string): Promise<InviteEligibilityResult> {
    const code = inviteCode.trim();
    const [invite] = await this.db.select().from(invites).where(eq(invites.code, code)).limit(1);
    if (!invite) {
      return { ok: false, code: "invalid_invite" };
    }

    const now = new Date();
    if (invite.expiresAt && invite.expiresAt <= now) {
      return { ok: false, code: "invite_expired" };
    }
    if (invite.usedCount >= invite.maxUses) {
      return { ok: false, code: "invite_exhausted" };
    }

    if (invite.programId) {
      const issuer = await this.findUserById(invite.createdByUserId);
      if (!issuer) {
        return { ok: false, code: "invalid_invite" };
      }
      const issuerMemberships = await this.getUserProgramMemberships(issuer.id);
      if (
        !canIssueProgramInvite(
          { id: issuer.id, role: issuer.role },
          invite.programId,
          invite.assignedRole,
          issuerMemberships,
        )
      ) {
        return { ok: false, code: "invalid_invite" };
      }
    }

    return { ok: true };
  }

  async redeemInviteAndCreateUser(input: {
    inviteCode: string;
    handle: string;
    passwordHash: string;
  }): Promise<RedeemInviteResult> {
    const code = input.inviteCode.trim();
    const cleanHandle = input.handle.trim();
    const normalized = normalizeHandle(cleanHandle);

    try {
      return await this.db.transaction(async (tx) => {
        // Check invite existence, expiry, quota, and issuer program authority BEFORE handle checks.
        const [invite] = await tx.select().from(invites).where(eq(invites.code, code)).limit(1);
        if (!invite) {
          return { ok: false, code: "invalid_invite" } as const;
        }

        const now = new Date();
        if (invite.expiresAt && invite.expiresAt <= now) {
          return { ok: false, code: "invite_expired" } as const;
        }
        if (invite.usedCount >= invite.maxUses) {
          return { ok: false, code: "invite_exhausted" } as const;
        }

        if (invite.programId) {
          const [issuer] = await tx
            .select({ id: users.id, role: users.role })
            .from(users)
            .where(eq(users.id, invite.createdByUserId))
            .limit(1);
          if (!issuer) {
            return { ok: false, code: "invalid_invite" } as const;
          }
          const issuerMemberships = await tx
            .select({
              programId: programMemberships.programId,
              userId: programMemberships.userId,
              role: programMemberships.role,
            })
            .from(programMemberships)
            .where(eq(programMemberships.userId, issuer.id));

          if (
            !canIssueProgramInvite(
              { id: issuer.id, role: issuer.role },
              invite.programId,
              invite.assignedRole,
              issuerMemberships,
            )
          ) {
            return { ok: false, code: "invalid_invite" } as const;
          }
        }

        const [existingUser] = await tx
          .select({ id: users.id })
          .from(users)
          .where(sql`lower(${users.handle}) = ${normalized}`)
          .limit(1);

        if (existingUser) {
          return { ok: false, code: "handle_taken" } as const;
        }

        // Atomic conditional increment prevents concurrent over-redemption.
        const [updatedInvite] = await tx
          .update(invites)
          .set({ usedCount: sql`${invites.usedCount} + 1` })
          .where(
            and(
              eq(invites.code, code),
              lt(invites.usedCount, invites.maxUses),
              or(isNull(invites.expiresAt), gt(invites.expiresAt, now)),
            ),
          )
          .returning();

        if (!updatedInvite) {
          return { ok: false, code: "invite_exhausted" } as const;
        }

        let created: typeof users.$inferSelect | undefined;
        try {
          [created] = await tx
            .insert(users)
            .values({
              handle: cleanHandle,
              passwordHash: input.passwordHash,
              role: updatedInvite.assignedRole,
            })
            .returning();
        } catch (err) {
          if (isPostgresUniqueViolation(err)) {
            throw new HandleTakenAbortError();
          }
          throw err;
        }

        if (!created) {
          throw new Error("Failed to create user record.");
        }

        const programIds: string[] = [];
        if (updatedInvite.programId) {
          const programRole = toProgramRole(updatedInvite.assignedRole);
          await tx
            .insert(programMemberships)
            .values({
              programId: updatedInvite.programId,
              userId: created.id,
              role: programRole,
            })
            .onConflictDoNothing();
          programIds.push(updatedInvite.programId);
        }

        return {
          ok: true,
          user: {
            id: created.id,
            handle: created.handle,
            passwordHash: created.passwordHash,
            role: created.role,
            createdAt: created.createdAt.toISOString(),
          },
          programIds,
        } as const;
      });
    } catch (err) {
      if (err instanceof HandleTakenAbortError) {
        return { ok: false, code: "handle_taken" };
      }
      throw err;
    }
  }

  async submitDoubleBlindLinkIntent(input: {
    initiatorUserId: string;
    initiatorHandle: string;
    targetHandle: string;
  }): Promise<"pending_unilateral" | "active"> {
    const normalizedInitiator = normalizeHandle(input.initiatorHandle);
    const normalizedTarget = normalizeHandle(input.targetHandle);

    if (normalizedInitiator === normalizedTarget) {
      return "pending_unilateral";
    }

    const lockKey = canonicalHandlePairLockKey(normalizedInitiator, normalizedTarget);

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      const [initiator] = await tx
        .select()
        .from(users)
        .where(eq(users.id, input.initiatorUserId))
        .limit(1);

      const [target] = await tx
        .select()
        .from(users)
        .where(sql`lower(${users.handle}) = ${normalizedTarget}`)
        .limit(1);

      if (initiator && target && initiator.id !== target.id) {
        const pair = resolveCoachStudentPair(initiator, target);
        if (pair) {
          const [activeLink] = await tx
            .select({ coachUserId: coachStudentLinks.coachUserId })
            .from(coachStudentLinks)
            .where(
              and(
                eq(coachStudentLinks.coachUserId, pair.coachUserId),
                eq(coachStudentLinks.studentUserId, pair.studentUserId),
                isNull(coachStudentLinks.revokedAt),
              ),
            )
            .limit(1);

          if (activeLink) {
            await tx
              .delete(linkIntents)
              .where(
                or(
                  and(
                    eq(linkIntents.initiatorUserId, target.id),
                    eq(linkIntents.targetHandle, normalizedInitiator),
                  ),
                  and(
                    eq(linkIntents.initiatorUserId, initiator.id),
                    eq(linkIntents.targetHandle, normalizedTarget),
                  ),
                ),
              );
            return "active";
          }

          const [reciprocal] = await tx
            .select()
            .from(linkIntents)
            .where(
              and(
                eq(linkIntents.initiatorUserId, target.id),
                eq(linkIntents.targetHandle, normalizedInitiator),
              ),
            )
            .limit(1);

          if (reciprocal) {
            await tx
              .insert(coachStudentLinks)
              .values({
                coachUserId: pair.coachUserId,
                studentUserId: pair.studentUserId,
                revokedAt: null,
              })
              .onConflictDoUpdate({
                target: [coachStudentLinks.coachUserId, coachStudentLinks.studentUserId],
                set: { revokedAt: null },
              });

            await tx
              .delete(linkIntents)
              .where(
                or(
                  and(
                    eq(linkIntents.initiatorUserId, target.id),
                    eq(linkIntents.targetHandle, normalizedInitiator),
                  ),
                  and(
                    eq(linkIntents.initiatorUserId, initiator.id),
                    eq(linkIntents.targetHandle, normalizedTarget),
                  ),
                ),
              );

            return "active";
          }
        }
      }

      await tx
        .insert(linkIntents)
        .values({
          initiatorUserId: input.initiatorUserId,
          targetHandle: normalizedTarget,
        })
        .onConflictDoNothing();

      return "pending_unilateral";
    });
  }

  async listActiveLinks(userId: string): Promise<ActiveLinkRecord[]> {
    const rows = await this.db
      .select()
      .from(coachStudentLinks)
      .where(
        and(
          isNull(coachStudentLinks.revokedAt),
          or(
            eq(coachStudentLinks.coachUserId, userId),
            eq(coachStudentLinks.studentUserId, userId),
          ),
        ),
      );

    const results: ActiveLinkRecord[] = [];
    for (const row of rows) {
      const isCoachSide = row.coachUserId === userId;
      const peerId = isCoachSide ? row.studentUserId : row.coachUserId;
      const peer = await this.findUserById(peerId);
      if (!peer) continue;
      results.push({
        peerUserId: peer.id,
        peerHandle: peer.handle,
        peerRole: peer.role,
        relation: isCoachSide ? "student" : "coach",
        createdAt: row.createdAt.toISOString(),
      });
    }
    return results;
  }

  async revokeActiveLink(userId: string, peerUserId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).limit(1);
      const [peer] = await tx.select().from(users).where(eq(users.id, peerUserId)).limit(1);

      if (user && peer) {
        const lockKey = canonicalHandlePairLockKey(user.handle, peer.handle);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      }

      const updated = await tx
        .update(coachStudentLinks)
        .set({ revokedAt: new Date() })
        .where(
          and(
            isNull(coachStudentLinks.revokedAt),
            or(
              and(
                eq(coachStudentLinks.coachUserId, userId),
                eq(coachStudentLinks.studentUserId, peerUserId),
              ),
              and(
                eq(coachStudentLinks.coachUserId, peerUserId),
                eq(coachStudentLinks.studentUserId, userId),
              ),
            ),
          ),
        )
        .returning();

      if (user && peer) {
        const normalizedUser = normalizeHandle(user.handle);
        const normalizedPeer = normalizeHandle(peer.handle);
        await tx
          .delete(linkIntents)
          .where(
            or(
              and(
                eq(linkIntents.initiatorUserId, user.id),
                eq(linkIntents.targetHandle, normalizedPeer),
              ),
              and(
                eq(linkIntents.initiatorUserId, peer.id),
                eq(linkIntents.targetHandle, normalizedUser),
              ),
            ),
          );
      }

      return updated.length > 0;
    });
  }
}

/**
 * In-memory identity repository for deterministic unit/integration tests and zero-Docker local dev.
 */
export class InMemoryIdentityRepository implements IdentityRepository {
  readonly storageKind = "memory" as const;
  private readonly usersById = new Map<string, UserRecord>();
  private readonly programsById = new Map<string, ProgramRecord>();
  private readonly programMembershipsByUser = new Map<string, Map<string, ProgramMembershipRecord>>();
  private readonly invitesByCode = new Map<string, InviteRecord>();
  private readonly pendingIntents = new Set<string>();
  private readonly links = new Map<
    string,
    { coachUserId: string; studentUserId: string; createdAt: string; revokedAt: string | null }
  >();

  seedProgram(input: { id?: string; name: string; ownerUserId: string }): ProgramRecord {
    const record: ProgramRecord = {
      id: input.id ?? randomUUID(),
      name: input.name.trim(),
      ownerUserId: input.ownerUserId,
      createdAt: new Date().toISOString(),
    };
    this.programsById.set(record.id, record);
    return { ...record };
  }

  addProgramMembership(membership: ProgramMembershipRecord): void {
    let byProgram = this.programMembershipsByUser.get(membership.userId);
    if (!byProgram) {
      byProgram = new Map<string, ProgramMembershipRecord>();
      this.programMembershipsByUser.set(membership.userId, byProgram);
    }
    byProgram.set(membership.programId, { ...membership });
  }

  removeProgramMembership(userId: string, programId: string): void {
    this.programMembershipsByUser.get(userId)?.delete(programId);
  }

  updateUserRole(userId: string, role: UserRole): void {
    const user = this.usersById.get(userId);
    if (user) {
      user.role = role;
    }
  }

  seedUser(input: {
    id?: string;
    handle: string;
    passwordHash: string;
    role: UserRole;
    programIds?: string[];
  }): UserRecord {
    const record: UserRecord = {
      id: input.id ?? randomUUID(),
      handle: input.handle.trim(),
      passwordHash: input.passwordHash,
      role: input.role,
      createdAt: new Date().toISOString(),
    };
    this.usersById.set(record.id, record);
    if (input.programIds?.length) {
      const programRole = toProgramRole(record.role);
      for (const programId of input.programIds) {
        this.addProgramMembership({
          programId,
          userId: record.id,
          role: programRole,
        });
      }
    }
    return record;
  }

  async findUserByHandle(handle: string): Promise<UserRecord | null> {
    const normalized = normalizeHandle(handle);
    for (const user of this.usersById.values()) {
      if (normalizeHandle(user.handle) === normalized) {
        return user;
      }
    }
    return null;
  }

  async findUserById(userId: string): Promise<UserRecord | null> {
    return this.usersById.get(userId) ?? null;
  }

  async getUserProgramIds(userId: string): Promise<string[]> {
    return [...(this.programMembershipsByUser.get(userId)?.keys() ?? [])];
  }

  async getUserProgramMemberships(userId: string): Promise<ProgramMembershipRecord[]> {
    const byProgram = this.programMembershipsByUser.get(userId);
    if (!byProgram) {
      return [];
    }
    return [...byProgram.values()].map((membership) => ({ ...membership }));
  }

  async programExists(programId: string): Promise<boolean> {
    return this.programsById.has(programId);
  }

  async createInvite(input: {
    createdByUserId: string;
    assignedRole: UserRole;
    programId?: string | null;
    maxUses: number;
    expiresAt?: Date | null;
  }): Promise<InviteRecord> {
    const record: InviteRecord = {
      code: generateInviteCode(),
      createdByUserId: input.createdByUserId,
      assignedRole: input.assignedRole,
      programId: input.programId ?? null,
      maxUses: input.maxUses,
      usedCount: 0,
      expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
      createdAt: new Date().toISOString(),
    };
    this.invitesByCode.set(record.code, record);
    return { ...record };
  }

  async listInvites(filter?: { createdByUserId?: string }): Promise<InviteRecord[]> {
    const all = [...this.invitesByCode.values()];
    const filtered = filter?.createdByUserId
      ? all.filter((inv) => inv.createdByUserId === filter.createdByUserId)
      : all;
    return filtered
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((inv) => ({ ...inv }));
  }

  private checkInviteEligibilitySync(inviteCode: string): InviteEligibilityResult {
    const invite = this.invitesByCode.get(inviteCode.trim());
    if (!invite) {
      return { ok: false, code: "invalid_invite" };
    }
    if (invite.expiresAt && new Date(invite.expiresAt) <= new Date()) {
      return { ok: false, code: "invite_expired" };
    }
    if (invite.usedCount >= invite.maxUses) {
      return { ok: false, code: "invite_exhausted" };
    }
    if (invite.programId) {
      const issuer = this.usersById.get(invite.createdByUserId);
      if (!issuer) {
        return { ok: false, code: "invalid_invite" };
      }
      const issuerMemberships = [
        ...(this.programMembershipsByUser.get(issuer.id)?.values() ?? []),
      ];
      if (
        !canIssueProgramInvite(
          { id: issuer.id, role: issuer.role },
          invite.programId,
          invite.assignedRole,
          issuerMemberships,
        )
      ) {
        return { ok: false, code: "invalid_invite" };
      }
    }
    return { ok: true };
  }

  async checkInviteEligibility(inviteCode: string): Promise<InviteEligibilityResult> {
    return this.checkInviteEligibilitySync(inviteCode);
  }

  async redeemInviteAndCreateUser(input: {
    inviteCode: string;
    handle: string;
    passwordHash: string;
  }): Promise<RedeemInviteResult> {
    // Check invite eligibility (including issuer program authority) BEFORE handle uniqueness.
    const eligibility = this.checkInviteEligibilitySync(input.inviteCode);
    if (!eligibility.ok) {
      return eligibility;
    }

    const normalized = normalizeHandle(input.handle);
    for (const user of this.usersById.values()) {
      if (normalizeHandle(user.handle) === normalized) {
        return { ok: false, code: "handle_taken" };
      }
    }

    const invite = this.invitesByCode.get(input.inviteCode.trim());
    if (!invite) {
      return { ok: false, code: "invalid_invite" };
    }

    invite.usedCount += 1;
    const programIds = invite.programId ? [invite.programId] : [];
    const user = this.seedUser({
      handle: input.handle,
      passwordHash: input.passwordHash,
      role: invite.assignedRole,
      programIds,
    });

    return { ok: true, user, programIds };
  }

  async submitDoubleBlindLinkIntent(input: {
    initiatorUserId: string;
    initiatorHandle: string;
    targetHandle: string;
  }): Promise<"pending_unilateral" | "active"> {
    const normalizedInitiator = normalizeHandle(input.initiatorHandle);
    const normalizedTarget = normalizeHandle(input.targetHandle);
    if (normalizedInitiator === normalizedTarget) {
      return "pending_unilateral";
    }

    const initiator = this.usersById.get(input.initiatorUserId) ?? null;
    let target: UserRecord | null = null;
    for (const user of this.usersById.values()) {
      if (normalizeHandle(user.handle) === normalizedTarget) {
        target = user;
        break;
      }
    }

    if (initiator && target && initiator.id !== target.id) {
      const pair = resolveCoachStudentPair(initiator, target);
      if (pair) {
        const linkKey = `${pair.coachUserId}::${pair.studentUserId}`;
        const existingLink = this.links.get(linkKey);
        if (existingLink && existingLink.revokedAt === null) {
          this.pendingIntents.delete(`${target.id}::${normalizedInitiator}`);
          this.pendingIntents.delete(`${initiator.id}::${normalizedTarget}`);
          return "active";
        }

        const reciprocalKey = `${target.id}::${normalizedInitiator}`;
        if (this.pendingIntents.has(reciprocalKey)) {
          this.pendingIntents.delete(reciprocalKey);
          this.pendingIntents.delete(`${initiator.id}::${normalizedTarget}`);
          this.links.set(linkKey, {
            coachUserId: pair.coachUserId,
            studentUserId: pair.studentUserId,
            createdAt: new Date().toISOString(),
            revokedAt: null,
          });
          return "active";
        }
      }
    }

    this.pendingIntents.add(`${input.initiatorUserId}::${normalizedTarget}`);
    return "pending_unilateral";
  }

  async listActiveLinks(userId: string): Promise<ActiveLinkRecord[]> {
    const results: ActiveLinkRecord[] = [];
    for (const link of this.links.values()) {
      if (link.revokedAt !== null) continue;
      if (link.coachUserId !== userId && link.studentUserId !== userId) continue;
      const isCoachSide = link.coachUserId === userId;
      const peerId = isCoachSide ? link.studentUserId : link.coachUserId;
      const peer = this.usersById.get(peerId);
      if (!peer) continue;
      results.push({
        peerUserId: peer.id,
        peerHandle: peer.handle,
        peerRole: peer.role,
        relation: isCoachSide ? "student" : "coach",
        createdAt: link.createdAt,
      });
    }
    return results;
  }

  async revokeActiveLink(userId: string, peerUserId: string): Promise<boolean> {
    const user = this.usersById.get(userId);
    const peer = this.usersById.get(peerUserId);
    if (user && peer) {
      this.pendingIntents.delete(`${user.id}::${normalizeHandle(peer.handle)}`);
      this.pendingIntents.delete(`${peer.id}::${normalizeHandle(user.handle)}`);
    }

    for (const link of this.links.values()) {
      if (link.revokedAt !== null) continue;
      const matches =
        (link.coachUserId === userId && link.studentUserId === peerUserId) ||
        (link.coachUserId === peerUserId && link.studentUserId === userId);
      if (matches) {
        link.revokedAt = new Date().toISOString();
        return true;
      }
    }
    return false;
  }
}
