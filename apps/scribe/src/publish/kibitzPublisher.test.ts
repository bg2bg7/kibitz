import { describe, expect, it } from "vitest";
import type { SessionPayload } from "@suite/auth-core";
import { packPgnaArchive } from "@suite/pgna";
import { createDemoItalianDraft } from "../local/draftWorkspace";
import { publishArchiveToKibitz, validateKibitzApiBaseUrl } from "./kibitzPublisher";

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
  it("validates Kibitz API base URLs strictly (HTTPS or local HTTP only, no credentials)", () => {
    expect(validateKibitzApiBaseUrl("https://kibitz.example.com")).toEqual({
      ok: true,
      normalizedUrl: "https://kibitz.example.com",
    });
    expect(validateKibitzApiBaseUrl("https://kibitz.example.com/")).toEqual({
      ok: true,
      normalizedUrl: "https://kibitz.example.com",
    });
    expect(validateKibitzApiBaseUrl("http://localhost:4002")).toEqual({
      ok: true,
      normalizedUrl: "http://localhost:4002",
    });
    expect(validateKibitzApiBaseUrl("http://127.0.0.1:4002")).toEqual({
      ok: true,
      normalizedUrl: "http://127.0.0.1:4002",
    });
    expect(validateKibitzApiBaseUrl("http://[::1]:4002")).toEqual({
      ok: true,
      normalizedUrl: "http://[::1]:4002",
    });

    const remoteHttp = validateKibitzApiBaseUrl("http://example.com");
    expect(remoteHttp.ok).toBe(false);

    const jsScheme = validateKibitzApiBaseUrl("javascript:alert(1)");
    expect(jsScheme.ok).toBe(false);

    const fileScheme = validateKibitzApiBaseUrl("file:///etc/passwd");
    expect(fileScheme.ok).toBe(false);

    const embeddedCreds = validateKibitzApiBaseUrl("https://user:pass@example.com");
    expect(embeddedCreds.ok).toBe(false);
  });

  it("rejects unsafe API base URLs in publishArchiveToKibitz before calling fetch", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    let fetchCalls = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ studyId: "should-not-run" }), { status: 201 });
    };

    const badUrls = [
      "http://example.com",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:pass@example.com",
    ];

    for (const badUrl of badUrls) {
      const result = await publishArchiveToKibitz({
        kibitzApiBaseUrl: badUrl,
        session: makeSession("coach"),
        accessToken: "jwt-token-xyz",
        manifest: draft.manifest,
        archiveBytes: packed.zipBytes,
        fetchImpl: mockFetch,
      });

      expect(result.published).toBe(false);
      expect(result.message.length).toBeGreaterThan(0);
    }

    expect(fetchCalls).toBe(0);
  });

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

  it("accepts https remote and 127.0.0.1 loopback API base URLs in publishArchiveToKibitz", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    const capturedUrls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      capturedUrls.push(String(input));
      return new Response(JSON.stringify({ studyId: "study-ok" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    };

    for (const baseUrl of ["https://kibitz.example.com", "http://127.0.0.1:4002"]) {
      const result = await publishArchiveToKibitz({
        kibitzApiBaseUrl: baseUrl,
        session: makeSession("coach"),
        accessToken: "jwt-token-xyz",
        manifest: draft.manifest,
        archiveBytes: packed.zipBytes,
        fetchImpl: mockFetch,
      });
      expect(result.published).toBe(true);
    }

    expect(capturedUrls).toEqual([
      "https://kibitz.example.com/api/studies",
      "http://127.0.0.1:4002/api/studies",
    ]);
  });
});
