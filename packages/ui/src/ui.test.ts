import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AppShell,
  CURATED_STUDENT_EMOJIS,
  EmojiReactionBar,
  KibitzLogo,
  SUITE_SERVICES,
  fetchKibitzSession,
  isAllowedSuiteUrl,
  pullReadOnlyFromService,
  resolveApiUrl,
  resolveServiceUrl,
} from "./index.js";

describe("@suite/ui", () => {
  it("renders EmojiReactionBar with curated fixed buttons and zero text inputs", () => {
    const html = renderToStaticMarkup(createElement(EmojiReactionBar, { selected: "lightbulb" }));
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(CURATED_STUDENT_EMOJIS.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('aria-pressed="true"');
  });

  it("renders AppShell with subdomain, privacy badge, and optional Kibitz home link", () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        appName: "Arbiter",
        subdomain: "arbiter.kibitz.local",
        badge: "100% Offline PWA",
        homeHref: "http://localhost:5170",
        children: createElement("div", null, "Body"),
      }),
    );
    expect(html).toContain("Arbiter");
    expect(html).toContain("100% Offline PWA");
    expect(html).toContain('href="http://localhost:5170"');
    expect(html).toContain("Kibitz");
  });

  it("renders KibitzLogo SVG emblem and wordmark", () => {
    const html = renderToStaticMarkup(
      createElement(KibitzLogo, { size: "lg", subtitle: "Chess Suite" }),
    );
    expect(html).toContain("<svg");
    expect(html).toContain("Kibitz");
    expect(html).toContain("Chess Suite");
  });

  it("resolves web and API URLs across localhost, deployed subdomains, and env overrides", () => {
    expect(SUITE_SERVICES.map((s) => s.id)).toEqual([
      "scribe",
      "lecture",
      "hall",
      "arbiter",
      "seconds",
      "id",
    ]);

    expect(SUITE_SERVICES.find((s) => s.id === "id")?.status).toBe("available");

    expect(resolveServiceUrl("kibitz")).toBe("http://localhost:5170");
    expect(resolveServiceUrl("scribe")).toBe("http://localhost:5174");
    expect(resolveServiceUrl("lecture")).toBe("http://localhost:5172");
    expect(resolveApiUrl("id")).toBe("http://localhost:4001");
    expect(resolveApiUrl("hall")).toBe("http://localhost:4003");

    expect(
      resolveServiceUrl("scribe", {
        location: { protocol: "https:", hostname: "kibitz.example.org" },
      }),
    ).toBe("https://scribe.kibitz.example.org");

    expect(
      resolveApiUrl("id", {
        location: { protocol: "https:", hostname: "arbiter.kibitz.example.org" },
      }),
    ).toBe("https://id.kibitz.example.org");

    expect(
      resolveServiceUrl("kibitz", {
        location: { protocol: "https:", hostname: "lecture.kibitz.example.org" },
      }),
    ).toBe("https://kibitz.example.org");

    expect(
      resolveServiceUrl("hall", {
        env: { VITE_HALL_URL: "https://tournaments.club.org/" },
      }),
    ).toBe("https://tournaments.club.org");

    expect(isAllowedSuiteUrl("http://localhost:5170/")).toBe(true);
    expect(isAllowedSuiteUrl("http://localhost:5175/tournaments")).toBe(true);
    expect(isAllowedSuiteUrl("https://evil.example.com")).toBe(false);
    expect(
      isAllowedSuiteUrl("https://arbiter.kibitz.org/round/1", {
        location: { protocol: "https:", hostname: "id.kibitz.org" },
      }),
    ).toBe(true);
    expect(
      isAllowedSuiteUrl("https://evil.org/phish", {
        location: { protocol: "https:", hostname: "id.kibitz.org" },
      }),
    ).toBe(false);
  });

  it("performs strictly read-only GET pulls with credentials: include and zero body", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const mockFetch: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          authenticated: true,
          user: {
            sub: "11111111-1111-4111-8111-111111111111",
            handle: "arbiter_one",
            role: "coach",
            programIds: [],
            iat: 100,
            exp: 9999999999,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const session = await fetchKibitzSession({ fetchImpl: mockFetch });
    expect(session.authenticated).toBe(true);
    expect(session.user?.handle).toBe("arbiter_one");

    const pull = await pullReadOnlyFromService<{ authenticated: boolean }>(
      "hall",
      "/api/tournaments",
      { fetchImpl: mockFetch },
    );
    expect(pull.ok).toBe(true);
    expect(calls[1]?.url).toBe("http://localhost:4003/api/tournaments");
    expect(calls[1]?.init?.method).toBe("GET");
    expect(calls[1]?.init?.credentials).toBe("include");
    expect(calls[1]?.init?.body).toBeUndefined();
  });
});
