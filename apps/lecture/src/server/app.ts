import { randomUUID } from "node:crypto";
import {
  buildClearSessionCookieHeader,
  canStudentReadStudy,
  computeEffectiveStudentAccess,
  extractSessionToken,
  isAllowedSuiteOrigin,
  normalizeHandle,
  resolveAuthConfig,
  verifySessionToken,
  type EffectiveStudentAccess,
  type SessionJwtConfig,
  type SessionPayload,
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
  collectTagCounts,
  groupStudiesByTag,
  normalizeStudyTags,
  normalizeTag,
  parseRawTagsField,
} from "./tags.js";

const MAX_PGNA_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

const StudyVisibilitySchema = z.enum([
  "public_moderated",
  "coach_students",
  "program",
  "private",
]);

const UpdateStudyBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  tags: z.array(z.string()).optional(),
  visibility: StudyVisibilitySchema.optional(),
});

export interface StudyDto {
  id: string;
  title: string;
  description: string;
  tags: string[];
  ownerHandle: string;
  ownerRole: UserRole;
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
}

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
  viewer: SessionPayload | null,
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
  const app = new Hono();

  app.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const allowedOrigin = origin && isAllowedSuiteOrigin(origin, authConfig) ? origin : null;
    if (allowedOrigin) {
      c.header("Access-Control-Allow-Origin", allowedOrigin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

  async function authenticateOptional(c: Context): Promise<SessionPayload | null> {
    const token = extractSessionToken({
      authorization: c.req.header("authorization"),
      cookie: c.req.header("cookie"),
    });
    if (!token) {
      return null;
    }
    const verified = await verifySessionToken(token, authConfig);
    return verified.valid ? verified.payload : null;
  }

  async function resolveEffectiveAccess(
    viewer: SessionPayload | null,
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
    const token = extractSessionToken({
      authorization: c.req.header("authorization"),
      cookie: c.req.header("cookie"),
    });
    if (!token) {
      return c.json({ error: "Authentication required for coach assignments." }, 401);
    }
    const verified = await verifySessionToken(token, authConfig);
    if (!verified.valid || !verified.payload) {
      return c.json({ error: "Invalid or expired Kibitz ID session." }, 401);
    }
    return c.json({
      viewer: {
        sub: verified.payload.sub,
        handle: verified.payload.handle,
        role: verified.payload.role,
      },
      items: [],
      interactionPolicy: "emoji_only",
    });
  });

  /**
   * Publishes a validated PGNA v1.0 archive from Scribe with user-chosen tags.
   * Requires an authenticated coach, moderator, or admin Kibitz ID session.
   */
  app.post("/api/studies", async (c) => {
    const session = await authenticateOptional(c);
    if (!session) {
      return c.json({ error: "Sign in with Kibitz ID to publish a .pgna lecture." }, 401);
    }

    const ownerAccount = await repository.findAccountById(session.sub);
    if (!ownerAccount) {
      c.header("Set-Cookie", buildClearSessionCookieHeader(authConfig));
      return c.json(
        {
          error:
            "Your Kibitz ID session is no longer valid (account not found). Please sign in again.",
        },
        401,
      );
    }

    if (!canPublishRole(ownerAccount.role)) {
      return c.json(
        { error: "Only coach, moderator, or admin accounts may publish .pgna studies." },
        403,
      );
    }

    let formData: FormData;
    try {
      formData = await c.req.formData();
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
    if (fileEntry.size > MAX_PGNA_UPLOAD_BYTES) {
      return c.json({ error: "Uploaded .pgna archive exceeds the 50 MB limit." }, 413);
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

    const rawTitle = String(formData.get("title") ?? "").trim();
    const title = (rawTitle || "Untitled PGNA Study").slice(0, 200);
    const description = String(formData.get("description") ?? "").slice(0, 4000);

    const rawVisibility = String(formData.get("visibility") ?? "public_moderated").trim();
    const parsedVisibility = StudyVisibilitySchema.safeParse(rawVisibility || "public_moderated");
    if (!parsedVisibility.success) {
      return c.json({ error: `Unsupported visibility "${rawVisibility}".` }, 400);
    }
    const visibility = parsedVisibility.data;

    const rawProgramId = formData.get("programId");
    const programId =
      typeof rawProgramId === "string" && rawProgramId.trim() ? rawProgramId.trim() : null;

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

    // NOTE: Public studies are auto-approved for now so authors can browse and view them
    // immediately without login. Once the moderator queue UI lands, flip this to "pending".
    const moderationStatus = visibility === "public_moderated" ? "approved" : "pending";

    const studyId = randomUUID();
    const objectKey = `studies/${ownerAccount.id}/${studyId}.pgna`;

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
        ownerUserId: ownerAccount.id,
        ownerHandle: ownerAccount.handle,
        ownerRole: ownerAccount.role,
        programId,
        title,
        description,
        tags: normalizedTags.tags,
        pgnaObjectKey: objectKey,
        visibility,
        moderationStatus,
      });

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
      console.error("[lecture] failed to save study metadata:", err);
      const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
      const pgCode =
        typeof cause === "object" && cause !== null && "code" in cause
          ? (cause as { code?: unknown }).code
          : undefined;
      if (pgCode === "23503") {
        c.header("Set-Cookie", buildClearSessionCookieHeader(authConfig));
        return c.json(
          {
            error:
              "Your Kibitz ID session is no longer valid (account not found). Please sign in again.",
          },
          401,
        );
      }
      const causeMsg =
        cause instanceof Error && cause.message
          ? ` (${cause.message})`
          : "";
      return c.json(
        {
          error: `Failed to save study metadata: ${err instanceof Error ? err.message : String(err)}${causeMsg}`,
        },
        500,
      );
    }
  });

  /**
   * Lists studies visible to the caller (no login required for public approved studies).
   * Supports optional `?tag=`, `?author=`, and `?q=` query filters.
   */
  app.get("/api/studies", async (c) => {
    const viewer = await authenticateOptional(c);
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
        const haystack = [
          study.title,
          study.description,
          study.ownerHandle,
          ...study.tags,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(queryFilter)) {
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

    const viewer = await authenticateOptional(c);
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
    const viewer = await authenticateOptional(c);
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
    const viewer = await authenticateOptional(c);
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
    const session = await authenticateOptional(c);
    if (!session) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const studyId = c.req.param("id");
    const existing = await repository.getStudyById(studyId);
    if (!existing) {
      return c.json({ error: "Study not found." }, 404);
    }
    if (existing.ownerUserId !== session.sub && session.role !== "admin") {
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
      nextTags = normalized.tags;
    }

    const nextVisibility = parsed.data.visibility;
    const nextModeration =
      nextVisibility === "public_moderated" ? "approved" : undefined;

    const updated = await repository.updateStudy(studyId, {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(nextTags !== undefined ? { tags: nextTags } : {}),
      ...(nextVisibility !== undefined ? { visibility: nextVisibility } : {}),
      ...(nextModeration !== undefined ? { moderationStatus: nextModeration } : {}),
    });

    if (!updated) {
      return c.json({ error: "Study not found." }, 404);
    }

    return c.json({ study: toStudyDto(updated) });
  });

  /**
   * Deletes a study and its `.pgna` blob (owner or admin only).
   */
  app.delete("/api/studies/:id", async (c) => {
    const session = await authenticateOptional(c);
    if (!session) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const studyId = c.req.param("id");
    const existing = await repository.getStudyById(studyId);
    if (!existing) {
      return c.json({ error: "Study not found." }, 404);
    }
    if (existing.ownerUserId !== session.sub && session.role !== "admin") {
      return c.json({ error: "Only the study owner or an admin may delete this study." }, 403);
    }

    const deleted = await repository.deleteStudy(studyId);
    if (deleted) {
      await objectStore.delete(deleted.pgnaObjectKey).catch(() => undefined);
    }

    return c.json({ deleted: true, id: studyId });
  });

  return app;
}
