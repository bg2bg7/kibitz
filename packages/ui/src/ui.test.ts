import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AppShell,
  CURATED_STUDENT_EMOJIS,
  EmojiReactionBar,
  KibitzLogo,
  SUITE_SERVICES,
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

  it("resolves service URLs across localhost, deployed subdomains, and env overrides", () => {
    expect(SUITE_SERVICES.map((s) => s.id)).toEqual([
      "scribe",
      "lecture",
      "hall",
      "arbiter",
      "seconds",
      "id",
    ]);

    expect(resolveServiceUrl("kibitz")).toBe("http://localhost:5170");
    expect(resolveServiceUrl("scribe")).toBe("http://localhost:5174");
    expect(resolveServiceUrl("lecture")).toBe("http://localhost:5172");

    expect(
      resolveServiceUrl("scribe", {
        location: { protocol: "https:", hostname: "kibitz.example.org" },
      }),
    ).toBe("https://scribe.kibitz.example.org");

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
  });
});
