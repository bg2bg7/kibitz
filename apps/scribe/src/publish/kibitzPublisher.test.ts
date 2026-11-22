import { describe, expect, it } from "vitest";
import type { SessionPayload } from "@suite/auth-core";
import { packPgnaArchive } from "@suite/pgna";
import { createDemoItalianDraft } from "../local/draftWorkspace";
import { publishArchiveToKibitz } from "./kibitzPublisher";

function makeSession(role: SessionPayload["role"]): SessionPayload {
  return {
    sub: "00000000-0000-4000-8000-000000000001",
    handle: "coach-test",
    role,
    programIds: [],
    iat: 1_700_000_000,
    exp: 1_900_000_000,
  };
}

describe("@suite/scribe isolated publish client", () => {
  it("blocks student accounts from publishing to Kibitz", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    const result = await publishArchiveToKibitz({
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("student"),
      manifest: draft.manifest,
      archiveBytes: packed.zipBytes,
    });

    expect(result.published).toBe(false);
    expect(result.message).toContain("Only coach or admin");
  });

  it("validates the .pgna archive and POSTs multipart FormData for coach accounts", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    let capturedUrl = "";
    let capturedAuth = "";
    let capturedMethod = "";

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "";
      const hdrs = init?.headers as Record<string, string> | undefined;
      capturedAuth = hdrs?.["Authorization"] ?? "";
      return new Response(JSON.stringify({ studyId: "study-123" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    };

    const result = await publishArchiveToKibitz({
      kibitzApiBaseUrl: "http://localhost:4002/",
      session: makeSession("coach"),
      accessToken: "jwt-token-xyz",
      visibility: "coach_students",
      manifest: draft.manifest,
      archiveBytes: packed.zipBytes,
      fetchImpl: mockFetch,
    });

    expect(result.published).toBe(true);
    expect(result.studyId).toBe("study-123");
    expect(capturedUrl).toBe("http://localhost:4002/api/studies");
    expect(capturedMethod).toBe("POST");
    expect(capturedAuth).toBe("Bearer jwt-token-xyz");
  });
});
