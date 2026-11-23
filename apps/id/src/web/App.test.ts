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

  it("ID-05: keeps user visibly signed in and renders inline retry alert when sign-out fails", () => {
    const html = renderToStaticMarkup(
      createElement(App, {
        initialUser: {
          sub: "11111111-1111-4111-8111-111111111111",
          handle: "coach_alice",
          role: "coach",
          programIds: [],
          iat: 1_700_000_000,
          exp: 1_900_000_000,
        },
        initialLogoutError:
          "Unable to sign out cleanly. Your session may still be active — please try again.",
      }),
    );
    expect(html).toContain("@coach_alice");
    expect(html).toContain('id="id-sign-out-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("Unable to sign out cleanly.");
    expect(html).toContain('id="id-sign-out-retry-button"');
    expect(html).toContain("Retry Sign Out");
    expect(html).not.toContain("Sign in to Kibitz ID");
  });
});
