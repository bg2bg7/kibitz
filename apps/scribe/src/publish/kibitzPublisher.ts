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
export const MAX_PUBLISH_TITLE_LENGTH = 200;
export const MAX_PUBLISH_DESCRIPTION_LENGTH = 4000;
const TAG_VALID_PATTERN = /^[a-z0-9][a-z0-9 _-]{0,31}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

let fallbackIdempotencyCounter = 0;

export function createPublishIdempotencyKey(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    const uuid = cryptoObj.randomUUID();
    if (IDEMPOTENCY_KEY_PATTERN.test(uuid)) {
      return uuid;
    }
  }
  fallbackIdempotencyCounter += 1;
  let randomPart = "";
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    const bytes = new Uint8Array(12);
    cryptoObj.getRandomValues(bytes);
    randomPart = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  } else {
    randomPart = `${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
  }
  return `pub-${Date.now().toString(36)}-${fallbackIdempotencyCounter.toString(36)}-${randomPart}`.slice(
    0,
    128,
  );
}

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
  idempotencyKey?: string;
  /** Optional fetch implementation override for testing. */
  fetchImpl?: typeof fetch;
}

export interface PublishToKibitzResult {
  published: boolean;
  statusCode?: number;
  studyId?: string;
  ownerHandle?: string;
  tags?: string[];
  idempotentReplay?: boolean;
  message: string;
}

export type PublishMetadataValidationResult =
  | { ok: true; title: string; description: string; tags: string[] }
  | { ok: false; error: string };

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
  overflow: string[];
} {
  const tags: string[] = [];
  const invalid: string[] = [];
  const overflow: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawTags) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const normalized = normalizePublishTag(trimmed);
    if (!normalized) {
      invalid.push(trimmed);
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    if (tags.length >= MAX_PUBLISH_TAGS) {
      overflow.push(normalized);
      continue;
    }
    tags.push(normalized);
  }

  return { tags, invalid, overflow };
}

export function mergePendingTagInput(
  existingTags: readonly string[],
  rawInput: string,
): {
  tags: string[];
  invalid: string[];
  overflow: string[];
} {
  const pendingParts = rawInput.split(",");
  return normalizePublishTags([...existingTags, ...pendingParts]);
}

export function validatePublishMetadata(input: {
  title: string;
  description: string;
  tags: readonly string[];
}): PublishMetadataValidationResult {
  const trimmedTitle = input.title.trim();
  if (trimmedTitle.length > MAX_PUBLISH_TITLE_LENGTH) {
    return {
      ok: false,
      error: `Study title must be at most ${MAX_PUBLISH_TITLE_LENGTH} characters.`,
    };
  }
  if (input.description.length > MAX_PUBLISH_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      error: `Study description must be at most ${MAX_PUBLISH_DESCRIPTION_LENGTH} characters.`,
    };
  }
  const tagCheck = normalizePublishTags(input.tags);
  if (tagCheck.invalid.length > 0) {
    return {
      ok: false,
      error: `Invalid tag(s): ${tagCheck.invalid.join(", ")}. Use 1–${MAX_PUBLISH_TAG_LENGTH} letters, numbers, spaces, hyphens, or underscores.`,
    };
  }
  if (tagCheck.overflow.length > 0) {
    return {
      ok: false,
      error: `You can attach at most ${MAX_PUBLISH_TAGS} tags per PGNA study.`,
    };
  }
  return {
    ok: true,
    title: trimmedTitle || "Untitled PGNA Study",
    description: input.description,
    tags: tagCheck.tags,
  };
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

  const rawTitle = request.title ?? request.manifest.title ?? "";
  const rawDescription = request.description ?? request.manifest.description ?? "";
  const metadataCheck = validatePublishMetadata({
    title: rawTitle,
    description: rawDescription,
    tags: request.tags ?? [],
  });
  if (!metadataCheck.ok) {
    return {
      published: false,
      message: metadataCheck.error,
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

  const resolvedTitle = metadataCheck.title;
  const resolvedDescription = metadataCheck.description;

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
  form.append("tags", JSON.stringify(metadataCheck.tags));

  const headers: Record<string, string> = {};
  if (request.accessToken) {
    headers["Authorization"] = `Bearer ${request.accessToken}`;
  }
  const trimmedIdempotencyKey = request.idempotencyKey?.trim();
  if (trimmedIdempotencyKey) {
    headers["Idempotency-Key"] = trimmedIdempotencyKey;
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
    let returnedTags: string[] = metadataCheck.tags;
    let idempotentReplay = false;
    try {
      const payload = (await response.json()) as {
        id?: string;
        studyId?: string;
        idempotentReplay?: unknown;
        study?: { id?: string; ownerHandle?: string; tags?: string[] };
      };
      studyId = payload.studyId ?? payload.id ?? payload.study?.id;
      if (payload.study?.ownerHandle) {
        ownerHandle = payload.study.ownerHandle;
      }
      if (Array.isArray(payload.study?.tags)) {
        returnedTags = payload.study.tags;
      }
      idempotentReplay = Boolean(payload?.idempotentReplay);
    } catch {
      // ignore
    }

    return {
      published: true,
      statusCode: response.status,
      ...(studyId ? { studyId } : {}),
      ...(ownerHandle ? { ownerHandle } : {}),
      tags: returnedTags,
      idempotentReplay,
      message: studyId
        ? idempotentReplay
          ? `Already published to Lecture (ID: ${studyId}).`
          : `Published to Lecture (ID: ${studyId}).`
        : "Published .pgna study to Lecture.",
    };
  } catch (err) {
    return {
      published: false,
      message: `Network error connecting to ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export type PublishJobStatus = "idle" | "publishing" | "succeeded" | "failed";

export interface PublishJobState {
  status: PublishJobStatus;
  draftId: string | null;
  idempotencyKey: string | null;
  result: PublishToKibitzResult | null;
}

export const INITIAL_PUBLISH_JOB_STATE: PublishJobState = {
  status: "idle",
  draftId: null,
  idempotencyKey: null,
  result: null,
};

export interface StartPublishSubmission {
  draftId: string;
  kibitzApiBaseUrl: string;
  session: SessionPayload;
  accessToken?: string;
  visibility?: StudyVisibility;
  programId?: string | null;
  tags?: readonly string[];
  title?: string;
  description?: string;
  manifest: PgnaManifest;
  buildArchive: () => Promise<Uint8Array>;
  fetchImpl?: typeof fetch;
}

export interface PublishSessionControllerOptions {
  onStateChange?: (state: PublishJobState) => void;
  createKey?: () => string;
  publishImpl?: (request: PublishToKibitzRequest) => Promise<PublishToKibitzResult>;
  onUnauthorized?: () => void;
}

export interface PublishSessionController {
  getState: () => PublishJobState;
  startPublish: (submission: StartPublishSubmission) => Promise<PublishToKibitzResult>;
  syncActiveDraft: (draftId: string) => void;
  resetResult: () => void;
}

/**
 * External publish session controller owned outside the dismissible PublishModal.
 * Enforces a single in-flight submission guard, retains the idempotency key across retries
 * of a failed publish for the same draft, rotates the key after success or draft switch,
 * and preserves completed results even if the modal is closed while publishing.
 */
export function createPublishSessionController(
  options: PublishSessionControllerOptions = {},
): PublishSessionController {
  const createKey = options.createKey ?? createPublishIdempotencyKey;
  const doPublish = options.publishImpl ?? publishArchiveToKibitz;

  let state: PublishJobState = { ...INITIAL_PUBLISH_JOB_STATE };
  let inFlightPromise: Promise<PublishToKibitzResult> | null = null;

  const setState = (next: PublishJobState) => {
    state = next;
    options.onStateChange?.(next);
  };

  const startPublish = (submission: StartPublishSubmission): Promise<PublishToKibitzResult> => {
    if (inFlightPromise !== null || state.status === "publishing") {
      return (
        inFlightPromise ??
        Promise.resolve({
          published: false,
          message: "A publish is already in progress.",
        })
      );
    }

    const rawTitle = submission.title ?? submission.manifest.title ?? "";
    const rawDescription = submission.description ?? submission.manifest.description ?? "";
    const metadataCheck = validatePublishMetadata({
      title: rawTitle,
      description: rawDescription,
      tags: submission.tags ?? [],
    });
    if (!metadataCheck.ok) {
      const failResult: PublishToKibitzResult = {
        published: false,
        message: metadataCheck.error,
      };
      setState({
        status: "failed",
        draftId: submission.draftId,
        idempotencyKey:
          state.status === "failed" && state.draftId === submission.draftId
            ? state.idempotencyKey
            : null,
        result: failResult,
      });
      return Promise.resolve(failResult);
    }

    const shouldReuseKey =
      state.status === "failed" &&
      state.draftId === submission.draftId &&
      Boolean(state.idempotencyKey);
    const idempotencyKey =
      shouldReuseKey && state.idempotencyKey ? state.idempotencyKey : createKey();

    setState({
      status: "publishing",
      draftId: submission.draftId,
      idempotencyKey,
      result: null,
    });

    const jobPromise = (async (): Promise<PublishToKibitzResult> => {
      try {
        const archiveBytes = await submission.buildArchive();
        const res = await doPublish({
          kibitzApiBaseUrl: submission.kibitzApiBaseUrl,
          session: submission.session,
          accessToken: submission.accessToken,
          visibility: submission.visibility,
          programId: submission.programId,
          tags: metadataCheck.tags,
          title: metadataCheck.title,
          description: metadataCheck.description,
          manifest: submission.manifest,
          archiveBytes,
          idempotencyKey,
          fetchImpl: submission.fetchImpl,
        });

        if (!res.published && res.statusCode === 401) {
          options.onUnauthorized?.();
        }

        if (res.published) {
          setState({
            status: "succeeded",
            draftId: submission.draftId,
            idempotencyKey: null,
            result: res,
          });
        } else {
          setState({
            status: "failed",
            draftId: submission.draftId,
            idempotencyKey,
            result: res,
          });
        }
        return res;
      } catch (err) {
        const failResult: PublishToKibitzResult = {
          published: false,
          message: err instanceof Error ? err.message : "Failed to compile archive.",
        };
        setState({
          status: "failed",
          draftId: submission.draftId,
          idempotencyKey,
          result: failResult,
        });
        return failResult;
      } finally {
        inFlightPromise = null;
      }
    })();

    inFlightPromise = jobPromise;
    return jobPromise;
  };

  const syncActiveDraft = (draftId: string): void => {
    if (state.status === "publishing") {
      return;
    }
    if (state.draftId !== null && state.draftId !== draftId) {
      setState({
        status: "idle",
        draftId,
        idempotencyKey: null,
        result: null,
      });
    }
  };

  const resetResult = (): void => {
    if (state.status === "publishing") {
      return;
    }
    setState({
      status: "idle",
      draftId: state.draftId,
      idempotencyKey: null,
      result: null,
    });
  };

  return {
    getState: () => state,
    startPublish,
    syncActiveDraft,
    resetResult,
  };
}
