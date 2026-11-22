import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell, CURATED_STUDENT_EMOJIS, EmojiReactionBar } from "./index.js";

describe("@suite/ui", () => {
  it("renders EmojiReactionBar with curated fixed buttons and zero text inputs", () => {
    const html = renderToStaticMarkup(createElement(EmojiReactionBar, { selected: "lightbulb" }));
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(CURATED_STUDENT_EMOJIS.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('aria-pressed="true"');
  });

  it("renders AppShell with subdomain and privacy badge", () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        appName: "Arbiter",
        subdomain: "arbiter.kibitz.local",
        badge: "100% Offline PWA",
        children: createElement("div", null, "Body"),
      }),
    );
    expect(html).toContain("Arbiter");
    expect(html).toContain("100% Offline PWA");
  });
});
