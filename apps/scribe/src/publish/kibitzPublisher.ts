import type { SessionPayload } from "@suite/auth-core";
import { PGNA_MIME_TYPE, validatePgnaZip, type PgnaManifest } from "@suite/pgna";

export type StudyVisibility = "private" | "coach_students" | "program" | "public_moderated";

export interface PublishToKibitzRequest {
  kibitzApiBaseUrl: string;
  session: SessionPayload;
  accessToken?: string;
  visibility?: StudyVisibility;
  manifest: PgnaManifest;
  archiveBytes: Uint8Array;
  /** Optional fetch implementation override for testing. */
  fetchImpl?: typeof fetch;
}

export interface PublishToKibitzResult {
  published: boolean;
  statusCode?: number;
  studyId?: string;
  message: string;
}

/**
 * Isolated optional publishing module for apps/scribe.
 * ESLint boundary rules permit @suite/auth-core imports ONLY inside apps/scribe/src/publish/**.
 */
export async function publishArchiveToKibitz(
  request: PublishToKibitzRequest,
): Promise<PublishToKibitzResult> {
  if (request.session.role !== "coach" && request.session.role !== "admin") {
    return {
      published: false,
      message: "Only coach or admin accounts may publish .pgna studies to Kibitz.",
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

  const endpoint = `${request.kibitzApiBaseUrl.replace(/\/+$/, "")}/api/studies`;
  const form = new FormData();
  const safeCopy = new Uint8Array(request.archiveBytes.byteLength);
  safeCopy.set(request.archiveBytes);
  const slug = (request.manifest.title || "study")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  form.append(
    "file",
    new Blob([safeCopy], { type: PGNA_MIME_TYPE }),
    `${slug || "study"}.pgna`,
  );
  form.append("title", request.manifest.title || "Untitled PGNA Study");
  form.append("description", request.manifest.description || "");
  form.append("visibility", request.visibility ?? "private");

  const headers: Record<string, string> = {};
  if (request.accessToken) {
    headers["Authorization"] = `Bearer ${request.accessToken}`;
  }

  const doFetch = request.fetchImpl ?? fetch;
  try {
    const response = await doFetch(endpoint, {
      method: "POST",
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
    try {
      const payload = (await response.json()) as { id?: string; studyId?: string };
      studyId = payload.studyId ?? payload.id;
    } catch {
      // ignore
    }

    return {
      published: true,
      statusCode: response.status,
      ...(studyId ? { studyId } : {}),
      message: studyId
        ? `Published to Kibitz (study ID: ${studyId}).`
        : "Published .pgna study to Kibitz.",
    };
  } catch (err) {
    return {
      published: false,
      message: `Network error connecting to ${endpoint}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
