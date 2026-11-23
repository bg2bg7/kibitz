import { describe, expect, it } from "vitest";
import type { SessionPayload } from "@suite/auth-core";
import { packPgnaArchive } from "@suite/pgna";
import { createDemoItalianDraft } from "../local/draftWorkspace";
import {
  fetchAccountExistingTags,
  normalizePublishTags,
  publishArchiveToKibitz,
  validateKibitzApiBaseUrl,
} from "./kibitzPublisher";

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

    expect(validateKibitzApiBaseUrl("http://example.com").ok).toBe(false);
    expect(validateKibitzApiBaseUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateKibitzApiBaseUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateKibitzApiBaseUrl("https://user:pass@example.com").ok).toBe(false);
  });

  it("normalizes, deduplicates, and validates publish tags", () => {
    const res = normalizePublishTags([" Openings ", "italian-game", "openings", "End  Games", ""]);
    expect(res).toEqual({
      tags: ["openings", "italian-game", "end games"],
      invalid: [],
    });

    const bad = normalizePublishTags(["valid-tag", "bad/tag!", "also?bad"]);
    expect(bad.tags).toEqual(["valid-tag"]);
    expect(bad.invalid).toEqual(["bad/tag!", "also?bad"]);
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
        manifest: draft.manifest,
        archiveBytes: packed.zipBytes,
        fetchImpl: mockFetch,
      });

      expect(result.published).toBe(false);
      expect(result.message.length).toBeGreaterThan(0);
    }

    expect(fetchCalls).toBe(0);
  });

  it("blocks student accounts from publishing to Kibitz while allowing coach, moderator, and admin", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    const studentResult = await publishArchiveToKibitz({
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("student"),
      manifest: draft.manifest,
      archiveBytes: packed.zipBytes,
    });
    expect(studentResult.published).toBe(false);
    expect(studentResult.message).toContain("Only coach, moderator, or admin");

    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ studyId: "study-mod" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });

    for (const role of ["coach", "moderator", "admin"] as const) {
      const res = await publishArchiveToKibitz({
        kibitzApiBaseUrl: "http://localhost:4002",
        session: makeSession(role),
        tags: ["openings"],
        manifest: draft.manifest,
        archiveBytes: packed.zipBytes,
        fetchImpl: mockFetch,
      });
      expect(res.published).toBe(true);
    }
  });

  it("uses credentials: include and transmits normalized tags & visibility in multipart FormData", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    let capturedUrl = "";
    let capturedMethod = "";
    let capturedCredentials: RequestCredentials | undefined;
    let capturedAuth = "";
    let capturedVisibility: FormDataEntryValue | null = null;
    let capturedTags: FormDataEntryValue | null = null;

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "";
      capturedCredentials = init?.credentials;
      const hdrs = init?.headers as Record<string, string> | undefined;
      capturedAuth = hdrs?.["Authorization"] ?? "";
      const form = init?.body as FormData;
      capturedVisibility = form.get("visibility");
      capturedTags = form.get("tags");
      return new Response(
        JSON.stringify({
          studyId: "study-123",
          study: {
            id: "study-123",
            ownerHandle: "coach-test",
            tags: ["openings", "italian-game"],
          },
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const result = await publishArchiveToKibitz({
      kibitzApiBaseUrl: "http://localhost:4002/",
      session: makeSession("coach"),
      tags: ["Openings", "italian-game", "openings"],
      manifest: draft.manifest,
      archiveBytes: packed.zipBytes,
      fetchImpl: mockFetch,
    });

    expect(result.published).toBe(true);
    expect(result.studyId).toBe("study-123");
    expect(result.ownerHandle).toBe("coach-test");
    expect(result.tags).toEqual(["openings", "italian-game"]);
    expect(capturedUrl).toBe("http://localhost:4002/api/studies");
    expect(capturedMethod).toBe("POST");
    expect(capturedCredentials).toBe("include");
    expect(capturedAuth).toBe("");
    expect(capturedVisibility).toBe("public_moderated");
    expect(capturedTags).toBe(JSON.stringify(["openings", "italian-game"]));
  });

  it("accepts https remote and 127.0.0.1 loopback API base URLs and fetches existing author tags", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    const capturedUrls: string[] = [];
    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      capturedUrls.push(url);
      if (url.includes("/api/accounts/")) {
        return new Response(
          JSON.stringify({
            tags: [
              { tag: "openings", count: 3 },
              { tag: "tactics", count: 1 },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
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

    const existingTags = await fetchAccountExistingTags(
      "http://localhost:4002",
      "coach-test",
      mockFetch,
    );
    expect(existingTags).toEqual(["openings", "tactics"]);

    expect(capturedUrls).toEqual([
      "https://kibitz.example.com/api/studies",
      "http://127.0.0.1:4002/api/studies",
      "http://localhost:4002/api/accounts/coach-test/studies",
    ]);
  });
});
