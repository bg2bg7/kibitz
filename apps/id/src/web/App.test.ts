import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("@suite/id web", () => {
  it("renders Hello World placeholder with invite-only badge and link back to Kibitz homepage", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("Hello, World!");
    expect(html).toContain("Kibitz ID");
    expect(html).toContain("Invite-Only Identity");
    expect(html).toContain('href="http://localhost:5170"');
  });
});
