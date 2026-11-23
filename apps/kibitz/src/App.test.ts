import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SUITE_SERVICES } from "@suite/ui";
import { App } from "./App";

describe("@suite/kibitz homepage", () => {
  it("renders Kibitz branding, top-menu Sign in prompt, and links to all six suite services", () => {
    const html = renderToStaticMarkup(createElement(App));

    expect(html).toContain("Kibitz");
    expect(html).toContain("Privacy-first chess tools");
    expect(html).toContain('id="nav-sign-in"');
    expect(html).toContain("Sign in");
    expect(html).toContain("3 live · 3 in development");

    for (const service of SUITE_SERVICES) {
      expect(html).toContain(service.name);
      expect(html).toContain(`id="service-link-${service.id}"`);
      expect(html).toContain(`http://localhost:${service.devPort}`);
    }

    expect(html).toContain("Available");
    expect(html).toContain("Coming Soon");
  });
});
