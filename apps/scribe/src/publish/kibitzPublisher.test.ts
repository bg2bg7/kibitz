import { describe, expect, it } from "vitest";
import type { SessionPayload } from "@suite/auth-core";
import { packPgnaArchive } from "@suite/pgna";
import { createDemoItalianDraft } from "../local/draftWorkspace";
import {
  MAX_PUBLISH_DESCRIPTION_LENGTH,
  MAX_PUBLISH_TAGS,
  MAX_PUBLISH_TITLE_LENGTH,
  createPublishIdempotencyKey,
  createPublishSessionController,
  fetchAccountExistingTags,
  fetchPublishablePrograms,
  mergePendingTagInput,
  normalizePublishTags,
  publishArchiveToKibitz,
  validateKibitzApiBaseUrl,
  validatePublishMetadata,
  type PublishJobState,
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

  it("normalizes, deduplicates, tracks overflow, and validates publish tags", () => {
    const res = normalizePublishTags([" Openings ", "italian-game", "openings", "End  Games", ""]);
    expect(res).toEqual({
      tags: ["openings", "italian-game", "end games"],
      invalid: [],
      overflow: [],
    });

    const bad = normalizePublishTags(["valid-tag", "bad/tag!", "also?bad"]);
    expect(bad.tags).toEqual(["valid-tag"]);
    expect(bad.invalid).toEqual(["bad/tag!", "also?bad"]);
    expect(bad.overflow).toEqual([]);
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

  it("generates idempotency keys matching the server contract pattern (SCR-05)", () => {
    const key1 = createPublishIdempotencyKey();
    const key2 = createPublishIdempotencyKey();
    expect(key1).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(key2).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(key1).not.toBe(key2);
  });

  it("accepts exact boundary metadata (200-char title, 4000-char description, 12 unique tags) unchanged in FormData (SCR-05)", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    const exactTitle = "T".repeat(MAX_PUBLISH_TITLE_LENGTH);
    const exactDescription = "D".repeat(MAX_PUBLISH_DESCRIPTION_LENGTH);
    const exactTags = Array.from({ length: MAX_PUBLISH_TAGS }, (_, i) => `tag-${i + 1}`);

    const check = validatePublishMetadata({
      title: exactTitle,
      description: exactDescription,
      tags: [...exactTags, "TAG-1"], // duplicate should deduplicate before counting
    });
    expect(check).toEqual({
      ok: true,
      title: exactTitle,
      description: exactDescription,
      tags: exactTags,
    });

    let capturedTitle: FormDataEntryValue | null = null;
    let capturedDescription: FormDataEntryValue | null = null;
    let capturedTags: FormDataEntryValue | null = null;
    const mockFetch: typeof fetch = async (_input, init) => {
      const form = init?.body as FormData;
      capturedTitle = form.get("title");
      capturedDescription = form.get("description");
      capturedTags = form.get("tags");
      return new Response(
        JSON.stringify({
          studyId: "study-boundary",
          study: { id: "study-boundary", ownerHandle: "coach-test", tags: exactTags },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const res = await publishArchiveToKibitz({
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("coach"),
      title: exactTitle,
      description: exactDescription,
      tags: exactTags,
      manifest: draft.manifest,
      archiveBytes: packed.zipBytes,
      fetchImpl: mockFetch,
    });

    expect(res.published).toBe(true);
    expect(res.studyId).toBe("study-boundary");
    expect(capturedTitle).toBe(exactTitle);
    expect(capturedDescription).toBe(exactDescription);
    expect(capturedTags).toBe(JSON.stringify(exactTags));
  });

  it("rejects overflow metadata (201-char title, 4001-char description, 13 unique tags) before calling fetch (SCR-05)", async () => {
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

    const overTitle = await publishArchiveToKibitz({
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("coach"),
      title: "T".repeat(MAX_PUBLISH_TITLE_LENGTH + 1),
      description: "ok",
      tags: ["openings"],
      manifest: draft.manifest,
      archiveBytes: packed.zipBytes,
      fetchImpl: mockFetch,
    });
    expect(overTitle.published).toBe(false);
    expect(overTitle.message).toBe(
      `Study title must be at most ${MAX_PUBLISH_TITLE_LENGTH} characters.`,
    );

    const overDescription = await publishArchiveToKibitz({
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("coach"),
      title: "Valid Title",
      description: "D".repeat(MAX_PUBLISH_DESCRIPTION_LENGTH + 1),
      tags: ["openings"],
      manifest: draft.manifest,
      archiveBytes: packed.zipBytes,
      fetchImpl: mockFetch,
    });
    expect(overDescription.published).toBe(false);
    expect(overDescription.message).toBe(
      `Study description must be at most ${MAX_PUBLISH_DESCRIPTION_LENGTH} characters.`,
    );

    const thirteenTags = Array.from({ length: MAX_PUBLISH_TAGS + 1 }, (_, i) => `tag-${i + 1}`);
    const overTags = await publishArchiveToKibitz({
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("coach"),
      title: "Valid Title",
      description: "Valid Description",
      tags: thirteenTags,
      manifest: draft.manifest,
      archiveBytes: packed.zipBytes,
      fetchImpl: mockFetch,
    });
    expect(overTags.published).toBe(false);
    expect(overTags.message).toBe(
      `You can attach at most ${MAX_PUBLISH_TAGS} tags per PGNA study.`,
    );

    expect(fetchCalls).toBe(0);
  });

  it("checks batched comma-separated tag input against accumulated count without silent truncation (SCR-05)", () => {
    const existingTen = Array.from({ length: 10 }, (_, i) => `t${i + 1}`);

    // Crossing the 12-tag cap in a single batched paste reports overflow instead of dropping tags
    const overflowBatch = mergePendingTagInput(existingTen, "t11, t12, t13, t14");
    expect(overflowBatch.tags).toHaveLength(12);
    expect(overflowBatch.invalid).toEqual([]);
    expect(overflowBatch.overflow).toEqual(["t13", "t14"]);

    // Duplicates within the batch are deduplicated before counting against the 12-tag limit
    const dedupedExact = mergePendingTagInput(existingTen, "T1, t11, t12, t11");
    expect(dedupedExact.tags).toEqual([...existingTen, "t11", "t12"]);
    expect(dedupedExact.invalid).toEqual([]);
    expect(dedupedExact.overflow).toEqual([]);
  });

  it("transmits Idempotency-Key header and handles both 201 create and 200 idempotentReplay responses (SCR-05)", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    const seenKeys: Array<string | undefined> = [];
    let attempt = 0;
    const mockFetch: typeof fetch = async (_input, init) => {
      attempt++;
      const hdrs = init?.headers as Record<string, string> | undefined;
      seenKeys.push(hdrs?.["Idempotency-Key"]);
      if (attempt === 1) {
        return new Response(
          JSON.stringify({
            studyId: "study-idem-1",
            idempotentReplay: false,
            study: { id: "study-idem-1", ownerHandle: "coach-test", tags: ["openings"] },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          studyId: "study-idem-1",
          idempotentReplay: true,
          study: { id: "study-idem-1", ownerHandle: "coach-test", tags: ["openings"] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const created = await publishArchiveToKibitz({
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("coach"),
      tags: ["openings"],
      manifest: draft.manifest,
      archiveBytes: packed.zipBytes,
      idempotencyKey: "  idem-key-123  ",
      fetchImpl: mockFetch,
    });
    expect(created.published).toBe(true);
    expect(created.statusCode).toBe(201);
    expect(created.studyId).toBe("study-idem-1");
    expect(created.idempotentReplay).toBe(false);

    const replayed = await publishArchiveToKibitz({
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("coach"),
      tags: ["openings"],
      manifest: draft.manifest,
      archiveBytes: packed.zipBytes,
      idempotencyKey: "idem-key-123",
      fetchImpl: mockFetch,
    });
    expect(replayed.published).toBe(true);
    expect(replayed.statusCode).toBe(200);
    expect(replayed.studyId).toBe("study-idem-1");
    expect(replayed.idempotentReplay).toBe(true);
    expect(seenKeys).toEqual(["idem-key-123", "idem-key-123"]);
  });

  it("enforces single in-flight publish across simulated modal close/reopen and retains result after completion (SCR-05)", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    let resolveResponse!: (res: Response) => void;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });

    let fetchCalls = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCalls++;
      return responsePromise;
    };

    const stateSnapshots: PublishJobState[] = [];
    const controller = createPublishSessionController({
      createKey: () => "idem-single-flight-1",
      onStateChange: (next) => stateSnapshots.push(next),
    });

    // Modal open -> user starts publish
    let modalOpen = true;
    const firstSubmit = controller.startPublish({
      draftId: draft.id,
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("coach"),
      tags: ["openings"],
      title: draft.manifest.title,
      description: draft.manifest.description,
      manifest: draft.manifest,
      buildArchive: async () => packed.zipBytes,
      fetchImpl: mockFetch,
    });

    expect(controller.getState().status).toBe("publishing");
    expect(controller.getState().idempotencyKey).toBe("idem-single-flight-1");

    // User closes modal and immediately reopens it while publish is still pending
    modalOpen = false;
    modalOpen = true;
    expect(modalOpen).toBe(true);
    expect(controller.getState().status).toBe("publishing");

    // Re-triggering submit while in-flight must return the same promise without another fetch
    const duplicateSubmit = controller.startPublish({
      draftId: draft.id,
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("coach"),
      tags: ["openings"],
      title: draft.manifest.title,
      description: draft.manifest.description,
      manifest: draft.manifest,
      buildArchive: async () => packed.zipBytes,
      fetchImpl: mockFetch,
    });
    expect(duplicateSubmit).toBe(firstSubmit);

    // User closes modal again before the server responds
    modalOpen = false;
    resolveResponse(
      new Response(
        JSON.stringify({
          studyId: "study-persisted-1",
          study: { id: "study-persisted-1", ownerHandle: "coach-test", tags: ["openings"] },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );

    const [res1, res2] = await Promise.all([firstSubmit, duplicateSubmit]);
    expect(fetchCalls).toBe(1);
    expect(res1.published).toBe(true);
    expect(res1.studyId).toBe("study-persisted-1");
    expect(res2).toEqual(res1);

    // User reopens modal after completion -> result is still stored and immediately retrievable
    modalOpen = true;
    expect(modalOpen).toBe(true);
    expect(controller.getState()).toEqual({
      status: "succeeded",
      draftId: draft.id,
      idempotencyKey: null,
      result: res1,
    });
    expect(stateSnapshots.map((s) => s.status)).toEqual(["publishing", "succeeded"]);
  });

  it("reuses idempotency key on retry after failure and rotates to a new key after success or draft switch (SCR-05)", async () => {
    const draft = createDemoItalianDraft();
    const packed = await packPgnaArchive({
      manifest: draft.manifest,
      pgnText: draft.pgnText,
    });

    let keySeq = 0;
    const sentKeys: Array<string | undefined> = [];
    let callNum = 0;
    const mockFetch: typeof fetch = async (_input, init) => {
      callNum++;
      const hdrs = init?.headers as Record<string, string> | undefined;
      sentKeys.push(hdrs?.["Idempotency-Key"]);
      if (callNum === 1) {
        return new Response(JSON.stringify({ error: "temporary outage" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (callNum === 2) {
        return new Response(
          JSON.stringify({
            studyId: "study-retry-ok",
            idempotentReplay: true,
            study: { id: "study-retry-ok", ownerHandle: "coach-test", tags: [] },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          studyId: "study-second-publish",
          study: { id: "study-second-publish", ownerHandle: "coach-test", tags: [] },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    };

    const controller = createPublishSessionController({
      createKey: () => `key-${++keySeq}`,
    });

    const baseSubmission = {
      draftId: draft.id,
      kibitzApiBaseUrl: "http://localhost:4002",
      session: makeSession("coach"),
      tags: [] as string[],
      title: "Study",
      description: "",
      manifest: draft.manifest,
      buildArchive: async () => packed.zipBytes,
      fetchImpl: mockFetch,
    };

    // 1. Initial publish fails -> retains key-1
    const failed = await controller.startPublish(baseSubmission);
    expect(failed.published).toBe(false);
    expect(controller.getState().status).toBe("failed");
    expect(controller.getState().idempotencyKey).toBe("key-1");

    // 2. Retry on same draft -> reuses key-1 and succeeds via idempotent replay -> clears key
    const retried = await controller.startPublish(baseSubmission);
    expect(retried.published).toBe(true);
    expect(retried.idempotentReplay).toBe(true);
    expect(controller.getState().status).toBe("succeeded");
    expect(controller.getState().idempotencyKey).toBeNull();

    // 3. Subsequent publish after success -> rotates to fresh key-2
    const nextPublish = await controller.startPublish(baseSubmission);
    expect(nextPublish.published).toBe(true);
    expect(nextPublish.studyId).toBe("study-second-publish");

    expect(sentKeys).toEqual(["key-1", "key-1", "key-2"]);

    // 4. Switching to another draft while idle/finished resets stale publish result
    controller.syncActiveDraft("draft-other");
    expect(controller.getState()).toEqual({
      status: "idle",
      draftId: "draft-other",
      idempotencyKey: null,
      result: null,
    });
  });
});
