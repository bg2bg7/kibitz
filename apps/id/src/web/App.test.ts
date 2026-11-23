import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("@suite/id web", () => {
  it("renders Kibitz ID sign-in and invite redemption UI with link back to Kibitz homepage", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("Sign in to Kibitz ID");
    expect(html).toContain("Redeem Invite");
    expect(html).toContain("Invite-Only Identity");
    expect(html).toContain("Read-only pull for offline PWAs");
    expect(html).toContain('href="http://localhost:5170"');
  });
});
