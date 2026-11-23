import { randomUUID } from "node:crypto";
import {
  normalizeHandle,
  type CoachStudentLinkRecord,
  type ProgramMembershipRecord,
  type UserRole,
} from "@suite/auth-core";
import {
  coachStudentLinks,
  desc,
  eq,
  or,
  programMemberships,
  programs,
  sql,
  studies,
  users,
  type SuiteDatabase,
} from "@suite/db";
import {
  DEFAULT_RETURN_PAUSE_MS,
  DEFAULT_SILENT_DURATION_MS,
  PGNA_FORMAT_VERSION,
  PGNA_MIME_TYPE,
  packPgnaArchive,
  type PgnaManifest,
} from "@suite/pgna";
import type { PgnaObjectStore } from "./objectStore.js";

export type StudyVisibility = "public_moderated" | "coach_students" | "program" | "private";
export type ModerationStatus = "pending" | "approved" | "rejected";

export interface StudyRecord {
  id: string;
  ownerUserId: string;
  ownerHandle: string;
  ownerRole: UserRole;
  programId: string | null;
  title: string;
  description: string;
  tags: string[];
  pgnaObjectKey: string;
  visibility: StudyVisibility;
  moderationStatus: ModerationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AccountProfile {
  id: string;
  handle: string;
  role: UserRole;
  createdAt: string;
}

export interface ProgramSummary {
  id: string;
  name: string;
}

export interface CreateStudyInput {
  id?: string;
  ownerUserId: string;
  ownerHandle: string;
  ownerRole: UserRole;
  programId?: string | null;
  title: string;
  description: string;
  tags: string[];
  pgnaObjectKey: string;
  visibility: StudyVisibility;
  moderationStatus: ModerationStatus;
}

export interface UpdateStudyInput {
  title?: string;
  description?: string;
  tags?: string[];
  visibility?: StudyVisibility;
  programId?: string | null;
  moderationStatus?: ModerationStatus;
}

export interface ViewerAccessContext {
  coachLinks: CoachStudentLinkRecord[];
  programMemberships: ProgramMembershipRecord[];
}

export interface StudyRepository {
  readonly storageKind: "postgres" | "memory";
  createStudy(input: CreateStudyInput): Promise<StudyRecord>;
  getStudyById(studyId: string): Promise<StudyRecord | null>;
  listAllStudies(): Promise<StudyRecord[]>;
  listStudiesByOwnerId(ownerUserId: string): Promise<StudyRecord[]>;
  findAccountById(userId: string): Promise<AccountProfile | null>;
  findAccountByHandle(handle: string): Promise<AccountProfile | null>;
  updateStudy(studyId: string, patch: UpdateStudyInput): Promise<StudyRecord | null>;
  deleteStudy(studyId: string): Promise<StudyRecord | null>;
  getViewerAccessContext(userId: string): Promise<ViewerAccessContext>;
  programExists(programId: string): Promise<boolean>;
  listAllPrograms(): Promise<ProgramSummary[]>;
  listProgramsByIds(programIds: readonly string[]): Promise<ProgramSummary[]>;
}

function toIso(date: Date | string): string {
  return date instanceof Date ? date.toISOString() : date;
}

function parseTagsArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string");
}

/**
 * PostgreSQL-backed Lecture study repository using `@suite/db` Drizzle ORM tables.
 */
export class PostgresStudyRepository implements StudyRepository {
  readonly storageKind = "postgres" as const;

  constructor(private readonly db: SuiteDatabase) {}

  async createStudy(input: CreateStudyInput): Promise<StudyRecord> {
    const id = input.id ?? randomUUID();
    const now = new Date();
    const [inserted] = await this.db
      .insert(studies)
      .values({
        id,
        ownerUserId: input.ownerUserId,
        programId: input.programId ?? null,
        title: input.title,
        description: input.description,
        tags: input.tags,
        pgnaObjectKey: input.pgnaObjectKey,
        visibility: input.visibility,
        moderationStatus: input.moderationStatus,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    if (!inserted) {
      throw new Error("Failed to insert study record.");
    }

    return {
      id: inserted.id,
      ownerUserId: inserted.ownerUserId,
      ownerHandle: input.ownerHandle,
      ownerRole: input.ownerRole,
      programId: inserted.programId,
      title: inserted.title,
      description: inserted.description,
      tags: parseTagsArray(inserted.tags),
      pgnaObjectKey: inserted.pgnaObjectKey,
      visibility: inserted.visibility,
      moderationStatus: inserted.moderationStatus,
      createdAt: toIso(inserted.createdAt),
      updatedAt: toIso(inserted.updatedAt),
    };
  }

  async getStudyById(studyId: string): Promise<StudyRecord | null> {
    const rows = await this.db
      .select({
        study: studies,
        ownerHandle: users.handle,
        ownerRole: users.role,
      })
      .from(studies)
      .innerJoin(users, eq(studies.ownerUserId, users.id))
      .where(eq(studies.id, studyId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.study.id,
      ownerUserId: row.study.ownerUserId,
      ownerHandle: row.ownerHandle,
      ownerRole: row.ownerRole,
      programId: row.study.programId,
      title: row.study.title,
      description: row.study.description,
      tags: parseTagsArray(row.study.tags),
      pgnaObjectKey: row.study.pgnaObjectKey,
      visibility: row.study.visibility,
      moderationStatus: row.study.moderationStatus,
      createdAt: toIso(row.study.createdAt),
      updatedAt: toIso(row.study.updatedAt),
    };
  }

  async listAllStudies(): Promise<StudyRecord[]> {
    const rows = await this.db
      .select({
        study: studies,
        ownerHandle: users.handle,
        ownerRole: users.role,
      })
      .from(studies)
      .innerJoin(users, eq(studies.ownerUserId, users.id))
      .orderBy(desc(studies.updatedAt));

    return rows.map((row) => ({
      id: row.study.id,
      ownerUserId: row.study.ownerUserId,
      ownerHandle: row.ownerHandle,
      ownerRole: row.ownerRole,
      programId: row.study.programId,
      title: row.study.title,
      description: row.study.description,
      tags: parseTagsArray(row.study.tags),
      pgnaObjectKey: row.study.pgnaObjectKey,
      visibility: row.study.visibility,
      moderationStatus: row.study.moderationStatus,
      createdAt: toIso(row.study.createdAt),
      updatedAt: toIso(row.study.updatedAt),
    }));
  }

  async listStudiesByOwnerId(ownerUserId: string): Promise<StudyRecord[]> {
    const rows = await this.db
      .select({
        study: studies,
        ownerHandle: users.handle,
        ownerRole: users.role,
      })
      .from(studies)
      .innerJoin(users, eq(studies.ownerUserId, users.id))
      .where(eq(studies.ownerUserId, ownerUserId))
      .orderBy(desc(studies.updatedAt));

    return rows.map((row) => ({
      id: row.study.id,
      ownerUserId: row.study.ownerUserId,
      ownerHandle: row.ownerHandle,
      ownerRole: row.ownerRole,
      programId: row.study.programId,
      title: row.study.title,
      description: row.study.description,
      tags: parseTagsArray(row.study.tags),
      pgnaObjectKey: row.study.pgnaObjectKey,
      visibility: row.study.visibility,
      moderationStatus: row.study.moderationStatus,
      createdAt: toIso(row.study.createdAt),
      updatedAt: toIso(row.study.updatedAt),
    }));
  }

  async findAccountById(userId: string): Promise<AccountProfile | null> {
    const [row] = await this.db
      .select({
        id: users.id,
        handle: users.handle,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!row) return null;
    return {
      id: row.id,
      handle: row.handle,
      role: row.role,
      createdAt: toIso(row.createdAt),
    };
  }

  async findAccountByHandle(handle: string): Promise<AccountProfile | null> {
    const normalized = normalizeHandle(handle);
    const [row] = await this.db
      .select({
        id: users.id,
        handle: users.handle,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(sql`lower(${users.handle}) = ${normalized}`)
      .limit(1);

    if (!row) return null;
    return {
      id: row.id,
      handle: row.handle,
      role: row.role,
      createdAt: toIso(row.createdAt),
    };
  }

  async updateStudy(studyId: string, patch: UpdateStudyInput): Promise<StudyRecord | null> {
    const existing = await this.getStudyById(studyId);
    if (!existing) return null;

    const now = new Date();
    const [updated] = await this.db
      .update(studies)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.programId !== undefined ? { programId: patch.programId } : {}),
        ...(patch.moderationStatus !== undefined
          ? { moderationStatus: patch.moderationStatus }
          : {}),
        updatedAt: now,
      })
      .where(eq(studies.id, studyId))
      .returning();

    if (!updated) return null;

    return {
      ...existing,
      programId: updated.programId,
      title: updated.title,
      description: updated.description,
      tags: parseTagsArray(updated.tags),
      visibility: updated.visibility,
      moderationStatus: updated.moderationStatus,
      updatedAt: toIso(updated.updatedAt),
    };
  }

  async deleteStudy(studyId: string): Promise<StudyRecord | null> {
    const existing = await this.getStudyById(studyId);
    if (!existing) return null;
    await this.db.delete(studies).where(eq(studies.id, studyId));
    return existing;
  }

  async getViewerAccessContext(userId: string): Promise<ViewerAccessContext> {
    const [links, memberships] = await Promise.all([
      this.db
        .select()
        .from(coachStudentLinks)
        .where(eq(coachStudentLinks.studentUserId, userId)),
      this.db
        .select()
        .from(programMemberships)
        .where(eq(programMemberships.userId, userId)),
    ]);

    return {
      coachLinks: links.map((l) => ({
        coachUserId: l.coachUserId,
        studentUserId: l.studentUserId,
        revokedAt: l.revokedAt ? toIso(l.revokedAt) : null,
      })),
      programMemberships: memberships.map((m) => ({
        programId: m.programId,
        userId: m.userId,
        role: m.role,
      })),
    };
  }

  async programExists(programId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: programs.id })
      .from(programs)
      .where(eq(programs.id, programId))
      .limit(1);
    return Boolean(row);
  }

  async listAllPrograms(): Promise<ProgramSummary[]> {
    const rows = await this.db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .orderBy(programs.name);
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  async listProgramsByIds(programIds: readonly string[]): Promise<ProgramSummary[]> {
    const uniqueIds = [...new Set(programIds.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return [];
    }
    const condition =
      uniqueIds.length === 1
        ? eq(programs.id, uniqueIds[0]!)
        : or(...uniqueIds.map((id) => eq(programs.id, id)));
    const rows = await this.db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .where(condition)
      .orderBy(programs.name);
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }
}

/**
 * Deterministic in-memory repository for unit tests and zero-DB local development.
 */
export class InMemoryStudyRepository implements StudyRepository {
  readonly storageKind = "memory" as const;

  private readonly accountsById = new Map<string, AccountProfile>();
  private readonly accountsByLowerHandle = new Map<string, string>();
  private readonly studiesById = new Map<string, StudyRecord>();
  private readonly programsById = new Map<string, ProgramSummary>();
  private readonly coachLinks: CoachStudentLinkRecord[] = [];
  private readonly memberships: ProgramMembershipRecord[] = [];

  registerAccount(account: { id: string; handle: string; role: UserRole; createdAt?: string }): AccountProfile {
    const existing = this.accountsById.get(account.id);
    if (existing) {
      return existing;
    }
    const record: AccountProfile = {
      id: account.id,
      handle: account.handle,
      role: account.role,
      createdAt: account.createdAt ?? new Date().toISOString(),
    };
    this.accountsById.set(record.id, record);
    this.accountsByLowerHandle.set(normalizeHandle(record.handle), record.id);
    return record;
  }

  updateAccountRole(userId: string, role: UserRole): AccountProfile | null {
    const existing = this.accountsById.get(userId);
    if (!existing) {
      return null;
    }
    const updated: AccountProfile = { ...existing, role };
    this.accountsById.set(userId, updated);
    for (const [studyId, study] of this.studiesById.entries()) {
      if (study.ownerUserId === userId) {
        this.studiesById.set(studyId, { ...study, ownerRole: role });
      }
    }
    return { ...updated };
  }

  deleteAccount(userId: string): boolean {
    const existing = this.accountsById.get(userId);
    if (!existing) {
      return false;
    }
    this.accountsById.delete(userId);
    this.accountsByLowerHandle.delete(normalizeHandle(existing.handle));
    return true;
  }

  registerProgram(program: ProgramSummary): ProgramSummary {
    const record: ProgramSummary = { id: program.id, name: program.name };
    this.programsById.set(record.id, record);
    return { ...record };
  }

  addCoachStudentLink(link: CoachStudentLinkRecord): void {
    this.coachLinks.push(link);
  }

  addProgramMembership(membership: ProgramMembershipRecord): void {
    this.memberships.push(membership);
  }

  async createStudy(input: CreateStudyInput): Promise<StudyRecord> {
    this.registerAccount({
      id: input.ownerUserId,
      handle: input.ownerHandle,
      role: input.ownerRole,
    });

    const now = new Date().toISOString();
    const record: StudyRecord = {
      id: input.id ?? randomUUID(),
      ownerUserId: input.ownerUserId,
      ownerHandle: input.ownerHandle,
      ownerRole: input.ownerRole,
      programId: input.programId ?? null,
      title: input.title,
      description: input.description,
      tags: [...input.tags],
      pgnaObjectKey: input.pgnaObjectKey,
      visibility: input.visibility,
      moderationStatus: input.moderationStatus,
      createdAt: now,
      updatedAt: now,
    };
    this.studiesById.set(record.id, record);
    return { ...record, tags: [...record.tags] };
  }

  async getStudyById(studyId: string): Promise<StudyRecord | null> {
    const found = this.studiesById.get(studyId);
    return found ? { ...found, tags: [...found.tags] } : null;
  }

  async listAllStudies(): Promise<StudyRecord[]> {
    return [...this.studiesById.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({ ...s, tags: [...s.tags] }));
  }

  async listStudiesByOwnerId(ownerUserId: string): Promise<StudyRecord[]> {
    return [...this.studiesById.values()]
      .filter((s) => s.ownerUserId === ownerUserId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((s) => ({ ...s, tags: [...s.tags] }));
  }

  async findAccountById(userId: string): Promise<AccountProfile | null> {
    return this.accountsById.get(userId) ?? null;
  }

  async findAccountByHandle(handle: string): Promise<AccountProfile | null> {
    const id = this.accountsByLowerHandle.get(normalizeHandle(handle));
    if (!id) return null;
    return this.accountsById.get(id) ?? null;
  }

  async updateStudy(studyId: string, patch: UpdateStudyInput): Promise<StudyRecord | null> {
    const existing = this.studiesById.get(studyId);
    if (!existing) return null;
    const updated: StudyRecord = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
      ...(patch.programId !== undefined ? { programId: patch.programId } : {}),
      ...(patch.moderationStatus !== undefined ? { moderationStatus: patch.moderationStatus } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.studiesById.set(studyId, updated);
    return { ...updated, tags: [...updated.tags] };
  }

  async deleteStudy(studyId: string): Promise<StudyRecord | null> {
    const existing = this.studiesById.get(studyId);
    if (!existing) return null;
    this.studiesById.delete(studyId);
    return { ...existing, tags: [...existing.tags] };
  }

  async getViewerAccessContext(userId: string): Promise<ViewerAccessContext> {
    return {
      coachLinks: this.coachLinks.filter((l) => l.studentUserId === userId),
      programMemberships: this.memberships.filter((m) => m.userId === userId),
    };
  }

  async programExists(programId: string): Promise<boolean> {
    return this.programsById.has(programId);
  }

  async listAllPrograms(): Promise<ProgramSummary[]> {
    return [...this.programsById.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ ...p }));
  }

  async listProgramsByIds(programIds: readonly string[]): Promise<ProgramSummary[]> {
    const wanted = new Set(programIds);
    return [...this.programsById.values()]
      .filter((p) => wanted.has(p.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ ...p }));
  }
}

/**
 * Seeds a real compiled PGNA v1.0 demo primer into an in-memory repository + object store
 * so the unauthenticated Lecture browser, /@demo_coach page, and PGNA viewer work out of the box.
 */
export async function seedDemoLecturePrimer(
  repository: InMemoryStudyRepository,
  objectStore: PgnaObjectStore,
): Promise<StudyRecord> {
  const demoCoachId = "00000000-0000-4000-8000-00000000d301";
  const demoStudyId = "00000000-0000-4000-8000-00000000a001";
  const now = new Date().toISOString();

  const manifest: PgnaManifest = {
    format: "pgna",
    version: PGNA_FORMAT_VERSION,
    pgnPath: "study.pgn",
    timelinePath: "timeline.json",
    title: "Italian Game Essentials (800–1200 Primer)",
    author: "@demo_coach",
    description:
      "Learn classical development, the f7 target, why Damiano's Defense falters, and test yourself with an interactive candidate-move prompt.",
    createdAt: now,
    updatedAt: now,
    defaultSubtitleLang: "en",
    compilation: {
      timingMode: "flow",
      defaultSilentDurationMs: DEFAULT_SILENT_DURATION_MS,
      defaultReturnPauseMs: DEFAULT_RETURN_PAUSE_MS,
      defaultGapMs: 0,
      includeUnscheduledAudio: false,
    },
    clips: {},
  };

  const pgnText = [
    '[Event "Italian Game Essentials"]',
    '[Site "Kibitz Lecture"]',
    '[White "White"]',
    '[Black "Black"]',
    '[Orientation "white"]',
    '[Result "*"]',
    "",
    "{ Welcome to the Italian Game! Watch how White develops rapidly toward f7. [%at #1 dur=2] [%csl Gf7] }",
    "1. e4 { Claim central space and open diagonals for the queen and bishop. [%cal Ge2e4,Gf1c4] [%at #2] }",
    "1... e5 { Black mirrors in the center. [%at #3] }",
    "2. Nf3 { Develop with tempo, attacking e5. [%cal Gg1f3,Rf3e5] [%at #4] [%at #6] [%cue 0.8 +csl=Re5] }",
    "2... Nc6 { Defend e5 naturally and prepare classical development. [%at #7] [%guess return=manual] }",
    "( 2... f6?! { Damiano's Defense weakens the king and runs into Nxe5! [%cal Rf7f6,Rf3e5] [%at #5 dur=2] } )",
    "3. Bc4! { The Italian Bishop aims directly at f7! [%cal Gf1c4,Rc4f7] [%at #8 dur=2] }",
    "( 3. Bb5 { The Ruy Lopez is another strong classical choice! [%outcome interesting] [%cal Bf1b5] } 3... a6 4. Ba4 )",
    "( 3. d4 { The Scotch Game immediately opens the center. [%outcome interesting] [%cal Yd2d4] } )",
    "*",
  ].join("\n");

  const packed = await packPgnaArchive({ manifest, pgnText });
  const objectKey = `studies/${demoCoachId}/${demoStudyId}.pgna`;
  await objectStore.put(objectKey, packed.zipBytes, PGNA_MIME_TYPE);

  return repository.createStudy({
    id: demoStudyId,
    ownerUserId: demoCoachId,
    ownerHandle: "demo_coach",
    ownerRole: "coach",
    title: manifest.title ?? "Italian Game Essentials",
    description: manifest.description ?? "",
    tags: ["openings", "italian-game", "beginner"],
    pgnaObjectKey: objectKey,
    visibility: "public_moderated",
    moderationStatus: "approved",
  });
}
