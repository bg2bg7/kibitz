import { describe, expect, it } from "vitest";
import type { SessionPayload } from "@suite/auth-core";
import { packPgnaArchive } from "@suite/pgna";
import { createDemoItalianDraft } from "../local/draftWorkspace";
import {
  fetchAccountExistingTags,
  fetchPublishablePrograms,
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

  it("uses credentials: include and transmits normalized tags & visibility in multipart FormData without programId for non-program visibility", async () => {
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
    let capturedProgramId: FormDataEntryValue | null = "unset";

    const mockFetch: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = init?.method ?? "";
      capturedCredentials = init?.credentials;
      const hdrs = init?.headers as Record<string, string> | undefined;
      capturedAuth = hdrs?.["Authorization"] ?? "";
      const form = init?.body as FormData;
      capturedVisibility = form.get("visibility");
      capturedTags = form.get("tags");
      capturedProgramId = form.get("programId");
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
      programId: "prog-ignored-for-public",
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
    expect(capturedProgramId).toBeNull();
  });

  it("fails fast before fetch when publishing with program visibility and missing or blank programId (LEC-02)", async () => {
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

    for (const missingProgramId of [undefined, null, "", "   "]) {
      const result = await publishArchiveToKibitz({
        kibitzApiBaseUrl: "http://localhost:4002",
        session: makeSession("coach"),
        visibility: "program",
        programId: missingProgramId,
        manifest: draft.manifest,
        archiveBytes: packed.zipBytes,
        fetchImpl: mockFetch,
      });

      expect(result.published).toBe(false);
      expect(result.message).toBe(
        "Select a target program before publishing with program visibility.",
      );
    }

    expect(fetchCalls).toBe(0);
  });

  it("blocks moderator accounts from publishing with program visibility before calling fetch (LEC-02)", async () => {
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

    const result = await publishArchiveToKibitz({
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("moderator"),
      visibility: "program",
      programId: "11111111-1111-4111-8111-111111111111",
      manifest: draft.manifest,
      archiveBytes: packed.zipBytes,
      fetchImpl: mockFetch,
    });

    expect(result.published).toBe(false);
    expect(result.message).toBe("Only coach or admin accounts may publish to a program.");
    expect(fetchCalls).toBe(0);
  });

  it("appends trimmed programId to FormData and succeeds for coach and admin with program visibility (LEC-02)", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    const capturedForms: Array<{
      visibility: FormDataEntryValue | null;
      programId: FormDataEntryValue | null;
    }> = [];

    const mockFetch: typeof fetch = async (_input, init) => {
      const form = init?.body as FormData;
      capturedForms.push({
        visibility: form.get("visibility"),
        programId: form.get("programId"),
      });
      return new Response(JSON.stringify({ studyId: "study-prog" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    };

    for (const role of ["coach", "admin"] as const) {
      const res = await publishArchiveToKibitz({
        kibitzApiBaseUrl: "http://localhost:4002",
        session: makeSession(role),
        visibility: "program",
        programId: "  prog-school-1  ",
        manifest: draft.manifest,
        archiveBytes: packed.zipBytes,
        fetchImpl: mockFetch,
      });
      expect(res.published).toBe(true);
      expect(res.studyId).toBe("study-prog");
    }

    expect(capturedForms).toEqual([
      { visibility: "program", programId: "prog-school-1" },
      { visibility: "program", programId: "prog-school-1" },
    ]);
  });

  it("fetches publishable programs from GET /api/programs/publishable and returns [] on errors or invalid URLs (LEC-02)", async () => {
    const capturedCalls: Array<{ url: string; method?: string; credentials?: RequestCredentials }> =
      [];
    const okFetch: typeof fetch = async (input, init) => {
      capturedCalls.push({
        url: String(input),
        method: init?.method,
        credentials: init?.credentials,
      });
      return new Response(
        JSON.stringify({
          programs: [
            { id: "prog-1", name: "Lincoln Chess Club" },
            { id: "  ", name: "Blank ID" },
            { id: "prog-2", name: "  " },
            { id: 123, name: "Bad Type" },
            { id: "prog-3", name: "  Westside Academy  " },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const programs = await fetchPublishablePrograms("http://localhost:4002/", okFetch);
    expect(programs).toEqual([
      { id: "prog-1", name: "Lincoln Chess Club" },
      { id: "prog-3", name: "Westside Academy" },
    ]);
    expect(capturedCalls).toEqual([
      {
        url: "http://localhost:4002/api/programs/publishable",
        method: "GET",
        credentials: "include",
      },
    ]);

    // Invalid URL fails safely without calling fetch
    let invalidCalls = 0;
    const countingFetch: typeof fetch = async () => {
      invalidCalls++;
      return new Response(JSON.stringify({ programs: [] }), { status: 200 });
    };
    expect(await fetchPublishablePrograms("http://remote-insecure.example.com", countingFetch)).toEqual(
      [],
    );
    expect(invalidCalls).toBe(0);

    // HTTP 403 / 500 and network errors return []
    expect(
      await fetchPublishablePrograms(
        "http://localhost:4002",
        async () => new Response(null, { status: 500 }),
      ),
    ).toEqual([]);
    expect(
      await fetchPublishablePrograms("http://localhost:4002", async () => {
        throw new Error("connection refused");
      }),
    ).toEqual([]);
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
