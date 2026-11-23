import { randomBytes, randomUUID } from "node:crypto";
import { normalizeHandle, type UserRole } from "@suite/auth-core";
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
  createInvite(input: {
    createdByUserId: string;
    assignedRole: UserRole;
    programId?: string | null;
    maxUses: number;
    expiresAt?: Date | null;
  }): Promise<InviteRecord>;
  listInvites(filter?: { createdByUserId?: string }): Promise<InviteRecord[]>;
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

  async redeemInviteAndCreateUser(input: {
    inviteCode: string;
    handle: string;
    passwordHash: string;
  }): Promise<RedeemInviteResult> {
    const code = input.inviteCode.trim();
    const cleanHandle = input.handle.trim();
    const normalized = normalizeHandle(cleanHandle);

    return this.db.transaction(async (tx) => {
      const [existingUser] = await tx
        .select({ id: users.id })
        .from(users)
        .where(sql`lower(${users.handle}) = ${normalized}`)
        .limit(1);

      if (existingUser) {
        return { ok: false, code: "handle_taken" } as const;
      }

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

      const [created] = await tx
        .insert(users)
        .values({
          handle: cleanHandle,
          passwordHash: input.passwordHash,
          role: updatedInvite.assignedRole,
        })
        .returning();

      if (!created) {
        throw new Error("Failed to create user record.");
      }

      const programIds: string[] = [];
      if (updatedInvite.programId) {
        const programRole =
          updatedInvite.assignedRole === "student"
            ? "student"
            : updatedInvite.assignedRole === "coach"
              ? "coach"
              : "director";
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

    return this.db.transaction(async (tx) => {
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

        const pair = resolveCoachStudentPair(initiator, target);
        if (reciprocal && pair) {
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
    const updated = await this.db
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

    return updated.length > 0;
  }
}

/**
 * In-memory identity repository for deterministic unit/integration tests and zero-Docker local dev.
 */
export class InMemoryIdentityRepository implements IdentityRepository {
  readonly storageKind = "memory" as const;
  private readonly usersById = new Map<string, UserRecord>();
  private readonly programIdsByUser = new Map<string, Set<string>>();
  private readonly invitesByCode = new Map<string, InviteRecord>();
  private readonly pendingIntents = new Set<string>();
  private readonly links = new Map<
    string,
    { coachUserId: string; studentUserId: string; createdAt: string; revokedAt: string | null }
  >();

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
      this.programIdsByUser.set(record.id, new Set(input.programIds));
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
    return [...(this.programIdsByUser.get(userId) ?? [])];
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

  async redeemInviteAndCreateUser(input: {
    inviteCode: string;
    handle: string;
    passwordHash: string;
  }): Promise<RedeemInviteResult> {
    const existing = await this.findUserByHandle(input.handle);
    if (existing) {
      return { ok: false, code: "handle_taken" };
    }

    const invite = this.invitesByCode.get(input.inviteCode.trim());
    if (!invite) {
      return { ok: false, code: "invalid_invite" };
    }
    if (invite.expiresAt && new Date(invite.expiresAt) <= new Date()) {
      return { ok: false, code: "invite_expired" };
    }
    if (invite.usedCount >= invite.maxUses) {
      return { ok: false, code: "invite_exhausted" };
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

    const initiator = await this.findUserById(input.initiatorUserId);
    const target = await this.findUserByHandle(normalizedTarget);

    if (initiator && target && initiator.id !== target.id) {
      const reciprocalKey = `${target.id}::${normalizedInitiator}`;
      const pair = resolveCoachStudentPair(initiator, target);
      if (this.pendingIntents.has(reciprocalKey) && pair) {
        this.pendingIntents.delete(reciprocalKey);
        this.pendingIntents.delete(`${initiator.id}::${normalizedTarget}`);
        const linkKey = `${pair.coachUserId}::${pair.studentUserId}`;
        this.links.set(linkKey, {
          coachUserId: pair.coachUserId,
          studentUserId: pair.studentUserId,
          createdAt: new Date().toISOString(),
          revokedAt: null,
        });
        return "active";
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
