import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { parseLectureLocation } from "./routes";

describe("@suite/lecture web", () => {
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
});
