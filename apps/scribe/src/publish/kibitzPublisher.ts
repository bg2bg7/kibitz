import type { SessionPayload } from "@suite/auth-core";
import { PGNA_MIME_TYPE, validatePgnaZip, type PgnaManifest } from "@suite/pgna";

export type StudyVisibility = "private" | "coach_students" | "program" | "public_moderated";

export const SUGGESTED_STUDY_TAGS = [
  "openings",
  "tactics",
  "endgames",
  "strategy",
  "annotated-games",
  "beginner",
] as const;

export const MAX_PUBLISH_TAGS = 12;
export const MAX_PUBLISH_TAG_LENGTH = 32;
const TAG_VALID_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,31}$/;

export interface PublishableProgram {
  id: string;
  name: string;
}

export interface PublishToKibitzRequest {
  kibitzApiBaseUrl: string;
  session: SessionPayload;
  accessToken?: string;
  visibility?: StudyVisibility;
  programId?: string | null;
  tags?: readonly string[];
  title?: string;
  description?: string;
  manifest: PgnaManifest;
  archiveBytes: Uint8Array;
  /** Optional fetch implementation override for testing. */
  fetchImpl?: typeof fetch;
}

export interface PublishToKibitzResult {
  published: boolean;
  statusCode?: number;
  studyId?: string;
  ownerHandle?: string;
  tags?: string[];
  message: string;
}

const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export type KibitzApiUrlValidationResult =
  | { ok: true; normalizedUrl: string }
  | { ok: false; error: string };

export function canRolePublishStudies(role: SessionPayload["role"]): boolean {
  return role === "coach" || role === "moderator" || role === "admin";
}

export function canRolePublishToProgram(role: SessionPayload["role"]): boolean {
  return role === "coach" || role === "admin";
}

export function normalizePublishTag(raw: string): string | null {
  const collapsed = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (!collapsed || collapsed.length > MAX_PUBLISH_TAG_LENGTH) {
    return null;
  }
  if (!TAG_VALID_PATTERN.test(collapsed)) {
    return null;
  }
  return collapsed;
}

export function normalizePublishTags(rawTags: readonly string[]): {
  tags: string[];
  invalid: string[];
} {
  const tags: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawTags) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = normalizePublishTag(trimmed);
    if (!normalized) {
      invalid.push(trimmed);
      continue;
    }
    if (seen.has(normalized) || tags.length >= MAX_PUBLISH_TAGS) {
      continue;
    }
    seen.add(normalized);
    tags.push(normalized);
  }

  return { tags, invalid };
}

/**
 * Validates that the Kibitz Lecture API base URL is safe to transmit credentials and archives to:
 * - Rejects malformed URLs and embedded credentials (`user:pass@host`).
 * - Allows `https:` for any host.
 * - Allows `http:` ONLY for local loopback dev hosts (`localhost`, `127.0.0.1`, `[::1]`, `::1`).
 * - Rejects all other schemes (`javascript:`, `file:`, remote cleartext `http://`, etc.).
 */
export function validateKibitzApiBaseUrl(rawUrl: string): KibitzApiUrlValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, error: "Kibitz API Base URL is required." };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `Invalid Kibitz API Base URL: "${trimmed}".` };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: "Kibitz API Base URL must not include embedded credentials (username/password).",
    };
  }

  if (parsed.protocol === "https:") {
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    return { ok: true, normalizedUrl: `${parsed.origin}${normalizedPath}` };
  }

  if (parsed.protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    if (!LOCAL_DEV_HOSTS.has(host)) {
      return {
        ok: false,
        error:
          "Remote Kibitz API Base URLs must use https:// (cleartext http:// is only permitted for localhost/loopback).",
      };
    }
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    return { ok: true, normalizedUrl: `${parsed.origin}${normalizedPath}` };
  }

  return {
    ok: false,
    error: `Unsupported URL scheme "${parsed.protocol}". Only https:// (or local http://) is allowed.`,
  };
}

/**
 * Best-effort fetch of existing tags used by the signed-in account on Lecture,
 * so authors can easily reuse consistent tags when publishing new PGNAs.
 */
export async function fetchAccountExistingTags(
  kibitzApiBaseUrl: string,
  handle: string,
  fetchImpl?: typeof fetch,
): Promise<string[]> {
  const urlCheck = validateKibitzApiBaseUrl(kibitzApiBaseUrl);
  if (!urlCheck.ok || !handle.trim()) {
    return [];
  }
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return [];
  }

  try {
    const res = await doFetch(
      `${urlCheck.normalizedUrl}/api/accounts/${encodeURIComponent(handle.trim())}/studies`,
      {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json" },
      },
    );
    if (!res.ok) {
      return [];
    }
    const body = (await res.json().catch(() => null)) as {
      tags?: Array<{ tag?: unknown }>;
    } | null;
    if (!body || !Array.isArray(body.tags)) {
      return [];
    }
    return body.tags
      .map((entry) => (typeof entry?.tag === "string" ? entry.tag : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Fetches the list of programs that the currently signed-in account is authorized to publish to.
 */
export async function fetchPublishablePrograms(
  kibitzApiBaseUrl: string,
  fetchImpl?: typeof fetch,
): Promise<PublishableProgram[]> {
  const urlCheck = validateKibitzApiBaseUrl(kibitzApiBaseUrl);
  if (!urlCheck.ok) {
    return [];
  }
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    return [];
  }

  try {
    const res = await doFetch(`${urlCheck.normalizedUrl}/api/programs/publishable`, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return [];
    }
    const body = (await res.json().catch(() => null)) as {
      programs?: Array<{ id?: unknown; name?: unknown }>;
    } | null;
    if (!body || !Array.isArray(body.programs)) {
      return [];
    }
    const programs: PublishableProgram[] = [];
    for (const entry of body.programs) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      const name = typeof entry?.name === "string" ? entry.name.trim() : "";
      if (id && name) {
        programs.push({ id, name });
      }
    }
    return programs;
  } catch {
    return [];
  }
}

/**
 * Isolated optional publishing module for apps/scribe.
 * ESLint boundary rules permit @suite/auth-core imports ONLY inside apps/scribe/src/publish/**.
 */
export async function publishArchiveToKibitz(
  request: PublishToKibitzRequest,
): Promise<PublishToKibitzResult> {
  const urlCheck = validateKibitzApiBaseUrl(request.kibitzApiBaseUrl);
  if (!urlCheck.ok) {
    return {
      published: false,
      message: urlCheck.error,
    };
  }

  if (!canRolePublishStudies(request.session.role)) {
    return {
      published: false,
      message: "Only coach, moderator, or admin accounts may publish .pgna studies to Kibitz.",
    };
  }

  const resolvedVisibility: StudyVisibility = request.visibility ?? "public_moderated";
  const normalizedProgramId = typeof request.programId === "string" ? request.programId.trim() : "";

  if (resolvedVisibility === "program") {
    if (!canRolePublishToProgram(request.session.role)) {
      return {
        published: false,
        message: "Only coach or admin accounts may publish to a program.",
      };
    }
    if (!normalizedProgramId) {
      return {
        published: false,
        message: "Select a target program before publishing with program visibility.",
      };
    }
  }

  const tagCheck = normalizePublishTags(request.tags ?? []);
  if (tagCheck.invalid.length > 0) {
    return {
      published: false,
      message: `Invalid tag(s): ${tagCheck.invalid.join(", ")}. Use 1–32 letters, numbers, spaces, hyphens, or underscores.`,
    };
  }

  const validation = await validatePgnaZip(request.archiveBytes);
  if (!validation.valid) {
    const firstError = validation.diagnostics.find((d) => d.severity === "error");
    return {
      published: false,
      message: `Archive failed PGNA v1.0 validation before upload: ${firstError?.code ?? "INVALID"} — ${firstError?.message ?? "unknown error"}`,
    };
  }

  const resolvedTitle = (request.title ?? request.manifest.title ?? "").trim() || "Untitled PGNA Study";
  const resolvedDescription = request.description ?? request.manifest.description ?? "";

  const endpoint = `${urlCheck.normalizedUrl}/api/studies`;
  const form = new FormData();
  const safeCopy = new Uint8Array(request.archiveBytes.byteLength);
  safeCopy.set(request.archiveBytes);
  const slug = resolvedTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  form.append(
    "file",
    new Blob([safeCopy], { type: PGNA_MIME_TYPE }),
    `${slug || "study"}.pgna`,
  );
  form.append("title", resolvedTitle);
  form.append("description", resolvedDescription);
  form.append("visibility", resolvedVisibility);
  if (resolvedVisibility === "program") {
    form.append("programId", normalizedProgramId);
  }
  form.append("tags", JSON.stringify(tagCheck.tags));

  const headers: Record<string, string> = {};
  if (request.accessToken) {
    headers["Authorization"] = `Bearer ${request.accessToken}`;
  }

  const doFetch = request.fetchImpl ?? fetch;
  try {
    const response = await doFetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers,
      body: form,
    });

    if (!response.ok) {
      let detail = response.statusText;
      try {
        const body = (await response.json()) as { error?: string; message?: string };
        detail = body.error || body.message || detail;
      } catch {
        // non-JSON response body
      }
      return {
        published: false,
        statusCode: response.status,
        message: `Kibitz server returned HTTP ${response.status}: ${detail}`,
      };
    }

    let studyId: string | undefined;
    let ownerHandle: string | undefined = request.session.handle;
    let returnedTags: string[] = tagCheck.tags;
    try {
      const payload = (await response.json()) as {
        id?: string;
        studyId?: string;
        study?: { id?: string; ownerHandle?: string; tags?: string[] };
      };
      studyId = payload.studyId ?? payload.id ?? payload.study?.id;
      if (payload.study?.ownerHandle) {
        ownerHandle = payload.study.ownerHandle;
      }
      if (Array.isArray(payload.study?.tags)) {
        returnedTags = payload.study.tags;
      }
    } catch {
      // ignore
    }

    return {
      published: true,
      statusCode: response.status,
      ...(studyId ? { studyId } : {}),
      ...(ownerHandle ? { ownerHandle } : {}),
      tags: returnedTags,
      message: studyId
        ? `Published to Lecture (ID: ${studyId}).`
        : "Published .pgna study to Lecture.",
    };
  } catch (err) {
    return {
      published: false,
      message: `Network error connecting to ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
