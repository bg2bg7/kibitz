import { randomUUID } from "node:crypto";
import {
  buildClearSessionCookieHeader,
  canPublishToProgram,
  canStudentReadStudy,
  computeEffectiveStudentAccess,
  extractSessionToken,
  isAllowedSuiteOrigin,
  normalizeHandle,
  resolveAuthConfig,
  verifySessionToken,
  type EffectiveStudentAccess,
  type SessionJwtConfig,
  type UserRole,
} from "@suite/auth-core";
import { PGNA_MIME_TYPE, validatePgnaZip } from "@suite/pgna";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { InMemoryPgnaObjectStore, type PgnaObjectStore } from "./objectStore.js";
import {
  InMemoryStudyRepository,
  type StudyRecord,
  type StudyRepository,
  type StudyVisibility,
} from "./repository.js";
import {
  MAX_STUDY_DESCRIPTION_LENGTH,
  MAX_STUDY_TAGS,
  MAX_STUDY_TITLE_LENGTH,
  collectTagCounts,
  groupStudiesByTag,
  normalizeStudyTags,
  normalizeTag,
  parseRawTagsField,
} from "./tags.js";

export { MAX_STUDY_DESCRIPTION_LENGTH, MAX_STUDY_TAGS, MAX_STUDY_TITLE_LENGTH } from "./tags.js";

export const MAX_PGNA_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const DEFAULT_MAX_UPLOAD_OVERHEAD_BYTES = 1024 * 1024; // 1 MB multipart overhead
const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;
const DEFAULT_OBJECT_DELETION_BACKOFF_MS = 30_000;
const MAX_OBJECT_DELETION_BACKOFF_MS = 60 * 60 * 1000; // 1 hour
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ALL_PENDING_DELETIONS_CUTOFF = new Date(8640000000000000);

const ZERO_DB_WRITE_ERROR =
  "Lecture is running in read-only zero-database dev mode. Configure DATABASE_URL (PostgreSQL) to enable cross-service publishing, editing, and deleting.";

const ProgramIdSchema = z.string().uuid();

const StudyVisibilitySchema = z.enum([
  "public_moderated",
  "coach_students",
  "program",
  "private",
]);

const UpdateStudyBodySchema = z.object({
  title: z.string().trim().min(1).max(MAX_STUDY_TITLE_LENGTH).optional(),
  description: z.string().max(MAX_STUDY_DESCRIPTION_LENGTH).optional(),
  tags: z.array(z.string()).optional(),
  visibility: StudyVisibilitySchema.optional(),
  programId: z.string().uuid().nullable().optional(),
});

export interface StudyDto {
  id: string;
  title: string;
  description: string;
  tags: string[];
  ownerHandle: string;
  ownerRole: UserRole;
  programId: string | null;
  visibility: StudyVisibility;
  moderationStatus: "pending" | "approved" | "rejected";
  archivePath: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLectureAppOptions {
  authConfig?: SessionJwtConfig;
  repository?: StudyRepository;
  objectStore?: PgnaObjectStore;
  readonlyZeroDbMode?: boolean;
  maxUploadBytes?: number;
  maxUploadRequestBytes?: number;
  maxConcurrentUploads?: number;
}

class PayloadTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Upload request body exceeds the ${maxBytes}-byte limit.`);
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Streams a Request body while enforcing a hard byte limit, cancelling the stream
 * immediately if incoming chunks exceed `maxBytes`.
 */
async function readBoundedBodyBytes(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const body = req.body;
  if (!body) {
    return new Uint8Array(new ArrayBuffer(0));
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new ArrayBuffer(totalBytes);
  const combined = new Uint8Array(buffer);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function computeNextObjectDeletionAttempt(
  attemptCount: number,
  now: Date,
  baseBackoffMs = DEFAULT_OBJECT_DELETION_BACKOFF_MS,
): Date {
  const exponent = Math.min(Math.max(0, attemptCount), 20);
  const delayMs = Math.min(baseBackoffMs * 2 ** exponent, MAX_OBJECT_DELETION_BACKOFF_MS);
  return new Date(now.getTime() + delayMs);
}

/**
 * Processes due study object-deletion jobs from the durable outbox queue (LEC-04).
 */
export async function processPendingObjectDeletions(
  repository: StudyRepository,
  objectStore: PgnaObjectStore,
  options: { now?: Date; limit?: number; baseBackoffMs?: number } = {},
): Promise<{ attempted: number; succeeded: number; failed: number }> {
  const dueCutoff = options.now ?? new Date();
  const recordedAt = dueCutoff.getUTCFullYear() > 9999 ? new Date() : dueCutoff;
  const limit = options.limit ?? 100;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_OBJECT_DELETION_BACKOFF_MS;

  const dueJobs = await repository.listDueObjectDeletions(dueCutoff, limit);
  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  for (const job of dueJobs) {
    attempted++;
    try {
      await objectStore.delete(job.pgnaObjectKey);
      await repository.markObjectDeletionSucceeded(job.id, recordedAt);
      succeeded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const nextAttemptAt = computeNextObjectDeletionAttempt(
        job.attemptCount,
        recordedAt,
        baseBackoffMs,
      );
      await repository.markObjectDeletionFailed(job.id, message, nextAttemptAt, recordedAt);
      failed++;
    }
  }

  return { attempted, succeeded, failed };
}

interface CurrentPrincipal {
  sub: string;
  handle: string;
  role: UserRole;
}

type PrincipalResolution =
  | { status: "anonymous"; principal: null }
  | { status: "invalid_token"; principal: null }
  | { status: "missing_account"; principal: null }
  | { status: "authenticated"; principal: CurrentPrincipal };

function canPublishRole(role: UserRole): boolean {
  return role === "coach" || role === "moderator" || role === "admin";
}

function toStudyDto(record: StudyRecord): StudyDto {
  return {
    id: record.id,
    title: record.title,
    description: record.description,
    tags: [...record.tags],
    ownerHandle: record.ownerHandle,
    ownerRole: record.ownerRole,
    programId: record.programId,
    visibility: record.visibility,
    moderationStatus: record.moderationStatus,
    archivePath: `/api/studies/${encodeURIComponent(record.id)}/archive`,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function slugifyFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "study";
}

function canViewerReadStudy(
  study: StudyRecord,
  viewer: CurrentPrincipal | null,
  effectiveAccess: EffectiveStudentAccess | null,
): boolean {
  if (study.visibility === "public_moderated" && study.moderationStatus === "approved") {
    return true;
  }
  if (!viewer) {
    return false;
  }
  if (viewer.sub === study.ownerUserId || viewer.role === "admin") {
    return true;
  }
  if (effectiveAccess) {
    return canStudentReadStudy(effectiveAccess, {
      id: study.id,
      ownerUserId: study.ownerUserId,
      programId: study.programId,
      visibility: study.visibility,
      moderationStatus: study.moderationStatus,
    });
  }
  return false;
}

export function createLectureApp(options: CreateLectureAppOptions = {}) {
  const authConfig = options.authConfig ?? resolveAuthConfig(process.env);
  const repository = options.repository ?? new InMemoryStudyRepository();
  const objectStore = options.objectStore ?? new InMemoryPgnaObjectStore();
  const readonlyZeroDbMode = options.readonlyZeroDbMode ?? false;
  const maxUploadBytes = options.maxUploadBytes ?? MAX_PGNA_UPLOAD_BYTES;
  const maxUploadRequestBytes =
    options.maxUploadRequestBytes ?? maxUploadBytes + DEFAULT_MAX_UPLOAD_OVERHEAD_BYTES;
  const maxConcurrentUploads = options.maxConcurrentUploads ?? DEFAULT_MAX_CONCURRENT_UPLOADS;
  const clearCookieOnMissingAccount = !readonlyZeroDbMode;

  let inFlightUploads = 0;
  const inFlightIdempotentUploads = new Map<
    string,
    { promise: Promise<StudyRecord | null>; resolve: (study: StudyRecord | null) => void }
  >();

  const app = new Hono();

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const allowedOrigin = origin && isAllowedSuiteOrigin(origin, authConfig) ? origin : null;
    if (allowedOrigin) {
      c.header("Access-Control-Allow-Origin", allowedOrigin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Idempotency-Key");
      c.header("Vary", "Origin");
    }
    if (c.req.method === "OPTIONS") {
      return c.body(null, allowedOrigin ? 204 : 403);
    }
    if (
      origin &&
      !allowedOrigin &&
      (c.req.method === "POST" || c.req.method === "PATCH" || c.req.method === "DELETE")
    ) {
      return c.json({ error: "Origin not allowed." }, 403);
    }
    await next();
  });

  async function resolveCurrentPrincipal(c: Context): Promise<PrincipalResolution> {
    const cookieHeader = c.req.header("cookie");
    const token = extractSessionToken({
      authorization: c.req.header("authorization"),
      cookie: cookieHeader,
    });
    if (!token) {
      return { status: "anonymous", principal: null };
    }

    const verified = await verifySessionToken(token, authConfig);
    if (!verified.valid || !verified.payload) {
      if (cookieHeader && !readonlyZeroDbMode) {
        c.header("Set-Cookie", buildClearSessionCookieHeader(authConfig));
      }
      return { status: "invalid_token", principal: null };
    }

    const account = await repository.findAccountById(verified.payload.sub);
    if (!account) {
      if (cookieHeader && clearCookieOnMissingAccount) {
        c.header("Set-Cookie", buildClearSessionCookieHeader(authConfig));
      }
      return { status: "missing_account", principal: null };
    }

    return {
      status: "authenticated",
      principal: {
        sub: account.id,
        handle: account.handle,
        role: account.role,
      },
    };
  }

  async function resolveEffectiveAccess(
    viewer: CurrentPrincipal | null,
  ): Promise<EffectiveStudentAccess | null> {
    if (!viewer) return null;
    const ctx = await repository.getViewerAccessContext(viewer.sub);
    return computeEffectiveStudentAccess(viewer.sub, ctx.coachLinks, ctx.programMemberships);
  }

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "lecture",
    }),
  );

  app.get("/api/primers", async (c) => {
    const all = await repository.listAllStudies();
    const publicStudies = all.filter(
      (s) => s.visibility === "public_moderated" && s.moderationStatus === "approved",
    );

    if (publicStudies.length > 0) {
      return c.json({
        visibility: "public_moderated",
        items: publicStudies.map((s) => ({
          id: s.id,
          title: s.title,
          ownerHandle: s.ownerHandle,
          tags: s.tags,
          format: "pgna-v1.0",
          requiresAuth: false,
        })),
      });
    }

    return c.json({
      visibility: "public_moderated",
      items: [
        {
          id: "primer-italian-800-1200",
          title: "Italian Game Essentials (800-1200 Primer)",
          format: "pgna-v1.0",
          requiresAuth: false,
        },
      ],
    });
  });

  app.get("/api/assignments", async (c) => {
    const resolved = await resolveCurrentPrincipal(c);
    if (resolved.status !== "authenticated") {
      const error =
        resolved.status === "anonymous"
          ? "Authentication required for coach assignments."
          : resolved.status === "missing_account"
            ? "Your Kibitz ID session is no longer valid (account not found). Please sign in again."
            : "Invalid or expired Kibitz ID session.";
      return c.json({ error }, 401);
    }

    return c.json({
      viewer: {
        sub: resolved.principal.sub,
        handle: resolved.principal.handle,
        role: resolved.principal.role,
      },
      items: [],
      interactionPolicy: "emoji_only",
    });
  });

  /**
   * Lists the programs that the currently authenticated principal is authorized to publish into.
   * Global admins see all programs; coaches see programs where they hold `director` or `coach`
   * membership; moderators and students receive an empty list.
   */
  app.get("/api/programs/publishable", async (c) => {
    const resolved = await resolveCurrentPrincipal(c);
    if (resolved.status !== "authenticated") {
      return c.json({ error: "Authentication required." }, 401);
    }
    const { principal } = resolved;
    if (principal.role === "admin") {
      const programs = await repository.listAllPrograms();
      return c.json({ programs });
    }
    if (principal.role === "coach") {
      const ctx = await repository.getViewerAccessContext(principal.sub);
      const eligibleIds = [
        ...new Set(
          ctx.programMemberships
            .filter((membership) =>
              canPublishToProgram(
                { id: principal.sub, role: principal.role },
                membership.programId,
                ctx.programMemberships,
              ),
            )
            .map((membership) => membership.programId),
        ),
      ];
      const programs = await repository.listProgramsByIds(eligibleIds);
      return c.json({ programs });
    }
    return c.json({ programs: [] });
  });

  /**
   * Publishes a validated PGNA v1.0 archive from Scribe with user-chosen tags.
   * Requires an authenticated coach, moderator, or admin Kibitz ID session.
   */
  app.post("/api/studies", async (c) => {
    if (readonlyZeroDbMode) {
      return c.json({ error: ZERO_DB_WRITE_ERROR }, 503);
    }

    const resolved = await resolveCurrentPrincipal(c);
    if (resolved.status !== "authenticated") {
      const error =
        resolved.status === "missing_account"
          ? "Your Kibitz ID session is no longer valid (account not found). Please sign in again."
          : "Sign in with Kibitz ID to publish a .pgna lecture.";
      return c.json({ error }, 401);
    }
    const { principal } = resolved;

    if (!canPublishRole(principal.role)) {
      return c.json(
        { error: "Only coach, moderator, or admin accounts may publish .pgna studies." },
        403,
      );
    }

    const rawIdempotencyKey = c.req.header("idempotency-key");
    let idempotencyKey: string | null = null;
    if (rawIdempotencyKey !== undefined) {
      const trimmedKey = rawIdempotencyKey.trim();
      if (!IDEMPOTENCY_KEY_PATTERN.test(trimmedKey)) {
        return c.json(
          {
            error:
              "Invalid Idempotency-Key header; must be 1–128 characters using letters, numbers, '.', '_', ':', or '-'.",
          },
          400,
        );
      }
      idempotencyKey = trimmedKey;
    }

    let flightKey: string | null = null;
    let flightEntry: {
      promise: Promise<StudyRecord | null>;
      resolve: (study: StudyRecord | null) => void;
    } | null = null;

    if (idempotencyKey !== null) {
      const key = `${principal.sub}:${idempotencyKey}`;
      const existingFlight = inFlightIdempotentUploads.get(key);
      if (existingFlight) {
        const coalesced = await existingFlight.promise;
        if (coalesced) {
          const dto = toStudyDto(coalesced);
          return c.json(
            {
              id: dto.id,
              studyId: dto.id,
              study: dto,
              idempotentReplay: true,
            },
            200,
          );
        }
      }

      let resolveFlight!: (study: StudyRecord | null) => void;
      const promise = new Promise<StudyRecord | null>((resolve) => {
        resolveFlight = resolve;
      });
      flightKey = key;
      flightEntry = { promise, resolve: resolveFlight };
      inFlightIdempotentUploads.set(key, flightEntry);
    }

    let acquiredUploadSlot = false;
    let resolvedIdempotentStudy: StudyRecord | null = null;

    try {
      if (idempotencyKey !== null) {
        const existingByKey = await repository.findStudyByIdempotencyKey(
          principal.sub,
          idempotencyKey,
        );
        if (existingByKey) {
          resolvedIdempotentStudy = existingByKey;
          const dto = toStudyDto(existingByKey);
          return c.json(
            {
              id: dto.id,
              studyId: dto.id,
              study: dto,
              idempotentReplay: true,
            },
            200,
          );
        }
      }

      if (inFlightUploads >= maxConcurrentUploads) {
        c.header("Retry-After", "5");
        return c.json(
          { error: "Too many concurrent uploads in progress. Please retry shortly." },
          429,
        );
      }
      inFlightUploads++;
      acquiredUploadSlot = true;

      const rawContentLength = c.req.header("content-length");
      if (rawContentLength !== undefined) {
        const parsedLength = Number(rawContentLength);
        if (Number.isFinite(parsedLength) && parsedLength > maxUploadRequestBytes) {
          return c.json(
            {
              error: `Upload request exceeds the ${maxUploadRequestBytes}-byte limit.`,
            },
            413,
          );
        }
      }

      let boundedBytes: Uint8Array<ArrayBuffer>;
      try {
        boundedBytes = await readBoundedBodyBytes(c.req.raw, maxUploadRequestBytes);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          return c.json({ error: err.message }, 413);
        }
        return c.json({ error: "Failed to read upload request stream." }, 400);
      }

      const contentType = c.req.header("content-type");
      if (!contentType) {
        return c.json({ error: "Expected multipart/form-data upload with a .pgna file." }, 400);
      }

      let formData: FormData;
      try {
        formData = await new Response(boundedBytes, {
          headers: { "content-type": contentType },
        }).formData();
      } catch {
        return c.json({ error: "Expected multipart/form-data upload with a .pgna file." }, 400);
      }

      const fileEntry = formData.get("file");
      if (!fileEntry || typeof fileEntry === "string") {
        return c.json({ error: 'Missing required "file" field containing a .pgna archive.' }, 400);
      }

      if (fileEntry.size === 0) {
        return c.json({ error: "Uploaded .pgna archive is empty." }, 400);
      }
      if (fileEntry.size > maxUploadBytes) {
        return c.json(
          {
            error:
              maxUploadBytes === MAX_PGNA_UPLOAD_BYTES
                ? "Uploaded .pgna archive exceeds the 50 MB limit."
                : `Uploaded .pgna archive exceeds the ${maxUploadBytes}-byte limit.`,
          },
          413,
        );
      }

      const rawTitleField = formData.get("title");
      const rawTitle = typeof rawTitleField === "string" ? rawTitleField.trim() : "";
      if (rawTitle.length > MAX_STUDY_TITLE_LENGTH) {
        return c.json(
          { error: `Title exceeds the ${MAX_STUDY_TITLE_LENGTH}-character limit.` },
          400,
        );
      }
      const title = rawTitle || "Untitled PGNA Study";

      const rawDescriptionField = formData.get("description");
      const description = typeof rawDescriptionField === "string" ? rawDescriptionField : "";
      if (description.length > MAX_STUDY_DESCRIPTION_LENGTH) {
        return c.json(
          { error: `Description exceeds the ${MAX_STUDY_DESCRIPTION_LENGTH}-character limit.` },
          400,
        );
      }

      const rawVisibility = String(formData.get("visibility") ?? "public_moderated").trim();
      const parsedVisibility = StudyVisibilitySchema.safeParse(rawVisibility || "public_moderated");
      if (!parsedVisibility.success) {
        return c.json({ error: `Unsupported visibility "${rawVisibility}".` }, 400);
      }
      const visibility = parsedVisibility.data;

      const rawProgramId = formData.get("programId");
      const trimmedProgramId =
        typeof rawProgramId === "string" && rawProgramId.trim() ? rawProgramId.trim() : null;
      if (trimmedProgramId !== null && !ProgramIdSchema.safeParse(trimmedProgramId).success) {
        return c.json({ error: "Invalid programId format; expected a UUID." }, 400);
      }

      let resolvedProgramId: string | null = null;
      if (visibility === "program") {
        if (!trimmedProgramId) {
          return c.json(
            { error: "A target program must be selected when visibility is set to program." },
            400,
          );
        }
        if (!(await repository.programExists(trimmedProgramId))) {
          return c.json({ error: "Target program not found." }, 404);
        }
        const ctx = await repository.getViewerAccessContext(principal.sub);
        if (
          !canPublishToProgram(
            { id: principal.sub, role: principal.role },
            trimmedProgramId,
            ctx.programMemberships,
          )
        ) {
          return c.json(
            {
              error: "Only admins and coaches assigned to that program may publish program studies.",
            },
            403,
          );
        }
        resolvedProgramId = trimmedProgramId;
      }

      const rawTags = parseRawTagsField(formData.get("tags"));
      const normalizedTags = normalizeStudyTags(rawTags);
      if (normalizedTags.invalid.length > 0) {
        return c.json(
          {
            error: `Invalid tag(s): ${normalizedTags.invalid.join(", ")}. Tags must be 1–32 characters using letters, numbers, spaces, hyphens, or underscores.`,
          },
          400,
        );
      }
      if (normalizedTags.overflow.length > 0) {
        return c.json(
          {
            error: `Too many tags: a study may have at most ${MAX_STUDY_TAGS} unique tags (overflow: ${normalizedTags.overflow.join(", ")}).`,
          },
          400,
        );
      }

      const bytes = new Uint8Array(await fileEntry.arrayBuffer());
      const validation = await validatePgnaZip(bytes);
      if (!validation.valid) {
        const firstError = validation.diagnostics.find((d) => d.severity === "error");
        return c.json(
          {
            error: `Invalid PGNA v1.0 archive: ${firstError?.code ?? "INVALID"} — ${firstError?.message ?? "validation failed"}`,
            diagnostics: validation.diagnostics,
          },
          400,
        );
      }

      // NOTE: Public studies are auto-approved for now so authors can browse and view them
      // immediately without login. Once the moderator queue UI lands, flip this to "pending".
      const moderationStatus = visibility === "public_moderated" ? "approved" : "pending";

      const studyId = randomUUID();
      const objectKey = `studies/${principal.sub}/${studyId}.pgna`;

      try {
        await objectStore.put(objectKey, bytes, PGNA_MIME_TYPE);
      } catch (err) {
        return c.json(
          {
            error: `Failed to persist .pgna archive to object storage: ${err instanceof Error ? err.message : String(err)}`,
          },
          502,
        );
      }

      try {
        const created = await repository.createStudy({
          id: studyId,
          ownerUserId: principal.sub,
          ownerHandle: principal.handle,
          ownerRole: principal.role,
          programId: resolvedProgramId,
          title,
          description,
          tags: normalizedTags.tags,
          pgnaObjectKey: objectKey,
          visibility,
          moderationStatus,
          idempotencyKey,
        });

        resolvedIdempotentStudy = created;
        const dto = toStudyDto(created);
        return c.json(
          {
            id: dto.id,
            studyId: dto.id,
            study: dto,
          },
          201,
        );
      } catch (err) {
        await objectStore.delete(objectKey).catch(() => undefined);
        const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
        const pgCode =
          typeof cause === "object" && cause !== null && "code" in cause
            ? (cause as { code?: unknown }).code
            : undefined;
        if (pgCode === "23505" && idempotencyKey !== null) {
          const existing = await repository.findStudyByIdempotencyKey(
            principal.sub,
            idempotencyKey,
          );
          if (existing) {
            resolvedIdempotentStudy = existing;
            const dto = toStudyDto(existing);
            return c.json(
              {
                id: dto.id,
                studyId: dto.id,
                study: dto,
                idempotentReplay: true,
              },
              200,
            );
          }
        }
        console.error("[lecture] failed to save study metadata:", err);
        if (pgCode === "23503") {
          if (c.req.header("cookie") && clearCookieOnMissingAccount) {
            c.header("Set-Cookie", buildClearSessionCookieHeader(authConfig));
          }
          return c.json(
            {
              error:
                "Your Kibitz ID session is no longer valid (account not found). Please sign in again.",
            },
            401,
          );
        }
        const causeMsg =
          cause instanceof Error && cause.message ? ` (${cause.message})` : "";
        return c.json(
          {
            error: `Failed to save study metadata: ${err instanceof Error ? err.message : String(err)}${causeMsg}`,
          },
          500,
        );
      }
    } finally {
      if (acquiredUploadSlot) {
        inFlightUploads--;
      }
      if (flightKey && flightEntry) {
        inFlightIdempotentUploads.delete(flightKey);
        flightEntry.resolve(resolvedIdempotentStudy);
      }
    }
  });

  /**
   * Lists studies visible to the caller (no login required for public approved studies).
   * Supports optional `?tag=`, `?author=`, and `?q=` query filters.
   */
  app.get("/api/studies", async (c) => {
    const { principal: viewer } = await resolveCurrentPrincipal(c);
    const effectiveAccess = await resolveEffectiveAccess(viewer);

    const allStudies = await repository.listAllStudies();
    const visible = allStudies.filter((study) =>
      canViewerReadStudy(study, viewer, effectiveAccess),
    );

    const tagCounts = collectTagCounts(visible);

    const authorCounts = new Map<string, { handle: string; role: UserRole; count: number }>();
    for (const study of visible) {
      if (study.ownerRole === "student" && viewer?.sub !== study.ownerUserId) {
        continue;
      }
      const key = normalizeHandle(study.ownerHandle);
      const existing = authorCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        authorCounts.set(key, {
          handle: study.ownerHandle,
          role: study.ownerRole,
          count: 1,
        });
      }
    }
    const authors = [...authorCounts.values()].sort(
      (a, b) => b.count - a.count || a.handle.localeCompare(b.handle),
    );

    const rawTag = c.req.query("tag");
    const tagFilter = rawTag ? normalizeTag(rawTag) : null;
    const rawAuthor = c.req.query("author")?.trim().replace(/^@+/, "");
    const authorFilter = rawAuthor ? normalizeHandle(rawAuthor) : null;
    const queryFilter = c.req.query("q")?.trim().toLowerCase() ?? "";

    const filtered = visible.filter((study) => {
      if (rawTag && !tagFilter) {
        return false;
      }
      if (tagFilter && !study.tags.includes(tagFilter)) {
        return false;
      }
      if (authorFilter && normalizeHandle(study.ownerHandle) !== authorFilter) {
        return false;
      }
      if (queryFilter) {
        const normalizedQueryHandle = queryFilter.replace(/^@+/, "");
        const haystack = [
          study.title,
          study.description,
          study.ownerHandle,
          `@${study.ownerHandle}`,
          ...study.tags,
        ]
          .join(" ")
          .toLowerCase();
        const matchesOwnerHandle =
          normalizedQueryHandle.length > 0 &&
          normalizeHandle(study.ownerHandle).includes(normalizedQueryHandle);
        if (!haystack.includes(queryFilter) && !matchesOwnerHandle) {
          return false;
        }
      }
      return true;
    });

    return c.json({
      studies: filtered.map(toStudyDto),
      tags: tagCounts,
      authors,
    });
  });

  /**
   * Returns an account's Lecture page organized by tags (no login required for public accounts).
   * Enforces Zero-PII student safety: student accounts never expose public profiles (404 to others).
   */
  app.get("/api/accounts/:handle/studies", async (c) => {
    const rawHandle = c.req.param("handle").trim().replace(/^@+/, "");
    if (!rawHandle) {
      return c.json({ error: "Account handle is required." }, 400);
    }

    const { principal: viewer } = await resolveCurrentPrincipal(c);
    const account = await repository.findAccountByHandle(rawHandle);
    if (!account) {
      return c.json({ error: `Account "@${rawHandle}" not found.` }, 404);
    }

    const isOwner = viewer?.sub === account.id;
    const isAdmin = viewer?.role === "admin";
    if (account.role === "student" && !isOwner && !isAdmin) {
      return c.json({ error: `Account "@${rawHandle}" not found.` }, 404);
    }

    const effectiveAccess = await resolveEffectiveAccess(viewer);
    const owned = await repository.listStudiesByOwnerId(account.id);
    const visibleDtos = owned
      .filter((study) => canViewerReadStudy(study, viewer, effectiveAccess))
      .map(toStudyDto);

    const grouped = groupStudiesByTag(visibleDtos);

    return c.json({
      account: {
        handle: account.handle,
        role: account.role,
      },
      isOwner,
      studies: visibleDtos,
      tagGroups: grouped.tagGroups,
      untagged: grouped.untagged,
      tags: grouped.tags,
    });
  });

  /**
   * Returns metadata for a single study (no login required for public approved studies).
   */
  app.get("/api/studies/:id", async (c) => {
    const studyId = c.req.param("id");
    const { principal: viewer } = await resolveCurrentPrincipal(c);
    const study = await repository.getStudyById(studyId);
    if (!study) {
      return c.json({ error: "Study not found." }, 404);
    }

    const effectiveAccess = await resolveEffectiveAccess(viewer);
    if (!canViewerReadStudy(study, viewer, effectiveAccess)) {
      return c.json({ error: "Study not found." }, 404);
    }

    const canEdit = Boolean(viewer && (viewer.sub === study.ownerUserId || viewer.role === "admin"));
    return c.json({
      study: toStudyDto(study),
      canEdit,
    });
  });

  /**
   * Streams the raw `.pgna` binary archive for playback or download (no login required for public studies).
   */
  app.get("/api/studies/:id/archive", async (c) => {
    const studyId = c.req.param("id");
    const { principal: viewer } = await resolveCurrentPrincipal(c);
    const study = await repository.getStudyById(studyId);
    if (!study) {
      return c.json({ error: "Study not found." }, 404);
    }

    const effectiveAccess = await resolveEffectiveAccess(viewer);
    if (!canViewerReadStudy(study, viewer, effectiveAccess)) {
      return c.json({ error: "Study not found." }, 404);
    }

    let bytes: Uint8Array | null;
    try {
      bytes = await objectStore.get(study.pgnaObjectKey);
    } catch (err) {
      console.error("[lecture] failed to read .pgna archive from object storage:", err);
      return c.json(
        {
          error: `Failed to read .pgna archive from storage: ${err instanceof Error ? err.message : String(err)}`,
        },
        502,
      );
    }
    if (!bytes) {
      return c.json({ error: "PGNA archive file missing from storage." }, 404);
    }

    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);

    const filename = `${slugifyFilename(study.title)}.pgna`;
    const isPublic =
      study.visibility === "public_moderated" && study.moderationStatus === "approved";

    c.header("Content-Type", PGNA_MIME_TYPE);
    c.header("Content-Disposition", `inline; filename="${filename}"`);
    c.header("Content-Length", String(copy.byteLength));
    c.header("Cache-Control", isPublic ? "public, max-age=60" : "private, no-store");
    return c.body(copy, 200);
  });

  /**
   * Updates study metadata/tags/visibility (owner or admin only).
   */
  app.patch("/api/studies/:id", async (c) => {
    if (readonlyZeroDbMode) {
      return c.json({ error: ZERO_DB_WRITE_ERROR }, 503);
    }

    const resolved = await resolveCurrentPrincipal(c);
    if (resolved.status !== "authenticated") {
      const error =
        resolved.status === "missing_account"
          ? "Your Kibitz ID session is no longer valid (account not found). Please sign in again."
          : "Authentication required.";
      return c.json({ error }, 401);
    }
    const { principal } = resolved;

    const studyId = c.req.param("id");
    const existing = await repository.getStudyById(studyId);
    if (!existing) {
      return c.json({ error: "Study not found." }, 404);
    }
    if (existing.ownerUserId !== principal.sub && principal.role !== "admin") {
      return c.json({ error: "Only the study owner or an admin may update this study." }, 403);
    }

    const parsed = UpdateStudyBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid study update payload." }, 400);
    }

    let nextTags: string[] | undefined;
    if (parsed.data.tags !== undefined) {
      const normalized = normalizeStudyTags(parsed.data.tags);
      if (normalized.invalid.length > 0) {
        return c.json(
          {
            error: `Invalid tag(s): ${normalized.invalid.join(", ")}.`,
          },
          400,
        );
      }
      if (normalized.overflow.length > 0) {
        return c.json(
          {
            error: `Too many tags: a study may have at most ${MAX_STUDY_TAGS} unique tags (overflow: ${normalized.overflow.join(", ")}).`,
          },
          400,
        );
      }
      nextTags = normalized.tags;
    }

    const nextVisibility = parsed.data.visibility ?? existing.visibility;
    const nextProgramId =
      parsed.data.programId !== undefined ? parsed.data.programId : existing.programId;

    let patchProgramId: string | null | undefined;
    if (nextVisibility === "program") {
      if (!nextProgramId) {
        return c.json(
          { error: "A target program must be selected when visibility is set to program." },
          400,
        );
      }
      if (!(await repository.programExists(nextProgramId))) {
        return c.json({ error: "Target program not found." }, 404);
      }
      const ctx = await repository.getViewerAccessContext(principal.sub);
      if (
        !canPublishToProgram(
          { id: principal.sub, role: principal.role },
          nextProgramId,
          ctx.programMemberships,
        )
      ) {
        return c.json(
          {
            error: "Only admins and coaches assigned to that program may publish program studies.",
          },
          403,
        );
      }
      if (parsed.data.programId !== undefined || parsed.data.visibility !== undefined) {
        patchProgramId = nextProgramId;
      }
    } else if (parsed.data.visibility !== undefined || parsed.data.programId !== undefined) {
      patchProgramId = null;
    }

    const nextModeration =
      parsed.data.visibility === "public_moderated" ? "approved" : undefined;

    const updated = await repository.updateStudy(studyId, {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(nextTags !== undefined ? { tags: nextTags } : {}),
      ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
      ...(patchProgramId !== undefined ? { programId: patchProgramId } : {}),
      ...(nextModeration !== undefined ? { moderationStatus: nextModeration } : {}),
    });

    if (!updated) {
      return c.json({ error: "Study not found." }, 404);
    }

    return c.json({ study: toStudyDto(updated) });
  });

  /**
   * Tombstones a study immediately and durably deletes its `.pgna` blob (owner or admin only).
   * If object storage fails transiently, the key is retained in `study_object_deletions` for retry
   * and `202 Accepted` is returned while the study is already hidden from all read paths (LEC-04).
   */
  app.delete("/api/studies/:id", async (c) => {
    if (readonlyZeroDbMode) {
      return c.json({ error: ZERO_DB_WRITE_ERROR }, 503);
    }

    const resolved = await resolveCurrentPrincipal(c);
    if (resolved.status !== "authenticated") {
      const error =
        resolved.status === "missing_account"
          ? "Your Kibitz ID session is no longer valid (account not found). Please sign in again."
          : "Authentication required.";
      return c.json({ error }, 401);
    }
    const { principal } = resolved;

    const studyId = c.req.param("id");
    const existing = await repository.getStudyByIdIncludingDeleted(studyId);
    if (!existing) {
      return c.json({ error: "Study not found." }, 404);
    }
    if (existing.ownerUserId !== principal.sub && principal.role !== "admin") {
      return c.json({ error: "Only the study owner or an admin may delete this study." }, 403);
    }

    const tombstoned = await repository.tombstoneStudyForDeletion(studyId);
    if (!tombstoned) {
      if (existing.deletedAt !== null) {
        return c.json({ deleted: true, id: studyId, cleanupStatus: "completed" }, 200);
      }
      return c.json({ error: "Study not found." }, 404);
    }

    if (tombstoned.deletionJob.status === "completed") {
      return c.json({ deleted: true, id: studyId, cleanupStatus: "completed" }, 200);
    }

    try {
      await objectStore.delete(tombstoned.study.pgnaObjectKey);
      await repository.markObjectDeletionSucceeded(tombstoned.deletionJob.id);
      return c.json({ deleted: true, id: studyId, cleanupStatus: "completed" }, 200);
    } catch (err) {
      const now = new Date();
      const message = err instanceof Error ? err.message : String(err);
      const nextAttemptAt = computeNextObjectDeletionAttempt(
        tombstoned.deletionJob.attemptCount,
        now,
      );
      await repository.markObjectDeletionFailed(
        tombstoned.deletionJob.id,
        message,
        nextAttemptAt,
        now,
      );
      return c.json({ deleted: true, id: studyId, cleanupStatus: "pending_retry" }, 202);
    }
  });

  /**
   * Operator visibility into pending/failed durable object deletions and failure counters (LEC-04).
   */
  app.get("/api/admin/object-deletions", async (c) => {
    const resolved = await resolveCurrentPrincipal(c);
    if (resolved.status !== "authenticated") {
      const error =
        resolved.status === "missing_account"
          ? "Your Kibitz ID session is no longer valid (account not found). Please sign in again."
          : "Authentication required.";
      return c.json({ error }, 401);
    }
    if (resolved.principal.role !== "admin") {
      return c.json({ error: "Admin access required." }, 403);
    }

    const [metrics, pending] = await Promise.all([
      repository.getObjectDeletionMetrics(),
      repository.listDueObjectDeletions(ALL_PENDING_DELETIONS_CUTOFF, 100),
    ]);
    return c.json({ metrics, pending });
  });

  /**
   * Operator-triggered immediate retry of all pending/failed study object deletions (LEC-04).
   */
  app.post("/api/admin/object-deletions/retry", async (c) => {
    if (readonlyZeroDbMode) {
      return c.json({ error: ZERO_DB_WRITE_ERROR }, 503);
    }

    const resolved = await resolveCurrentPrincipal(c);
    if (resolved.status !== "authenticated") {
      const error =
        resolved.status === "missing_account"
          ? "Your Kibitz ID session is no longer valid (account not found). Please sign in again."
          : "Authentication required.";
      return c.json({ error }, 401);
    }
    if (resolved.principal.role !== "admin") {
      return c.json({ error: "Admin access required." }, 403);
    }

    const summary = await processPendingObjectDeletions(repository, objectStore, {
      now: ALL_PENDING_DELETIONS_CUTOFF,
    });
    const metrics = await repository.getObjectDeletionMetrics();
    return c.json({ ...summary, metrics });
  });

  return app;
}
