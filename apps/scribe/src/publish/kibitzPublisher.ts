import type { SessionPayload } from "@suite/auth-core";
import type { PgnaManifest } from "@suite/pgna";

export interface PublishToKibitzRequest {
  kibitzApiBaseUrl: string;
  session: SessionPayload;
  manifest: PgnaManifest;
  archiveBytes: Uint8Array;
}

export interface PublishToKibitzResult {
  published: boolean;
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

  return {
    published: false,
    message: `Publish stub ready for ${request.kibitzApiBaseUrl} (${request.archiveBytes.byteLength} bytes).`,
  };
}
