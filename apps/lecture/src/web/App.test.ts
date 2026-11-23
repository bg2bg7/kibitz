import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { fetchPublishablePrograms, updateStudyMetadata } from "./api";
import { parseLectureLocation } from "./routes";

describe("@suite/lecture web", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses Lecture browser, account (/@handle), and viewer (/studies/:id) routes cleanly", () => {
    expect(parseLectureLocation("/", "")).toEqual({
      kind: "browser",
      tag: null,
      query: "",
    });
    expect(parseLectureLocation("/", "?tag=openings&q=italian")).toEqual({
      kind: "browser",
      tag: "openings",
      query: "italian",
    });
    expect(parseLectureLocation("/@demo_coach", "")).toEqual({
      kind: "account",
      handle: "demo_coach",
    });
    expect(parseLectureLocation("/studies/study-123", "")).toEqual({
      kind: "viewer",
      studyId: "study-123",
    });
  });

  it("renders unauthenticated Lecture browser with search, Scribe link, Kibitz home link, and optional sign-in", () => {
    const html = renderToStaticMarkup(createElement(App, { initialPath: "/" }));
    expect(html).toContain("Lecture");
    expect(html).toContain("Browse Chess Lectures");
    expect(html).toContain('aria-label="Search lectures"');
    expect(html).toContain('href="http://localhost:5170"');
    expect(html).toContain('href="http://localhost:5174"');
    expect(html).toContain('id="nav-sign-in"');
  });

  it("renders account page and viewer shells without requiring login", () => {
    const accountHtml = renderToStaticMarkup(createElement(App, { initialPath: "/@demo_coach" }));
    expect(accountHtml).toContain("Lecture");
    expect(accountHtml).toContain('id="nav-sign-in"');

    const viewerHtml = renderToStaticMarkup(
      createElement(App, { initialPath: "/studies/00000000-0000-4000-8000-00000000a001" }),
    );
    expect(viewerHtml).toContain("Lecture");
    expect(viewerHtml).toContain('id="nav-sign-in"');
  });

  it("fetches publishable programs and sends programId when updating study visibility", async () => {
    const programId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const studyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ programs: [{ id: programId, name: "Academy A" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            study: {
              id: studyId,
              title: "Endgame Basics",
              description: "",
              tags: ["endgames"],
              ownerHandle: "coach_a",
              ownerRole: "coach",
              programId,
              visibility: "program",
              moderationStatus: "pending",
              archivePath: `/api/studies/${studyId}/archive`,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const programs = await fetchPublishablePrograms();
    expect(programs).toEqual([{ id: programId, name: "Academy A" }]);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("/api/programs/publishable");
    expect(fetchSpy.mock.calls[0]?.[1]?.credentials).toBe("include");

    const updated = await updateStudyMetadata(studyId, {
      tags: ["endgames"],
      visibility: "program",
      programId,
    });
    expect(updated.programId).toBe(programId);
    expect(fetchSpy.mock.calls[1]?.[0]).toContain(`/api/studies/${studyId}`);
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({
      tags: ["endgames"],
      visibility: "program",
      programId,
    });
  });
});
