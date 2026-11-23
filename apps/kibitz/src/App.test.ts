import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SIGN_OUT_ERROR_MESSAGE,
  SUITE_SERVICES,
  logoutKibitzSession,
  performKibitzSignOut,
  type KibitzSessionUser,
} from "@suite/ui";
import { App } from "./App";
import { AuthMenu } from "./components/AuthMenu";

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

  it("keeps signed-in state visible with alert and Retry action when AuthMenu sign-out fails (ID-05)", async () => {
    const signedInUser: KibitzSessionUser = {
      sub: "22222222-2222-4222-8222-222222222222",
      handle: "coach_bob",
      role: "coach",
      programIds: [],
      iat: 100,
      exp: 9999999999,
    };

    let currentUser: KibitzSessionUser | null = signedInUser;
    let signOutError: string | null = null;

    const failedOk = await performKibitzSignOut({
      logout: () =>
        logoutKibitzSession({
          fetchImpl: async () => new Response(null, { status: 503 }),
        }),
      onSuccess: () => {
        currentUser = null;
        signOutError = null;
      },
      onFailure: (message) => {
        signOutError = message;
      },
    });

    expect(failedOk).toBe(false);
    expect(currentUser).toEqual(signedInUser);
    expect(signOutError).toBe(SIGN_OUT_ERROR_MESSAGE);

    const html = renderToStaticMarkup(
      createElement(AuthMenu, {
        initialUser: currentUser,
        initialSignOutError: signOutError,
      }),
    );

    expect(html).toContain("@coach_bob");
    expect(html).toContain('id="nav-sign-out"');
    expect(html).not.toContain('id="nav-sign-in"');
    expect(html).toContain('role="alert"');
    expect(html).toContain(SIGN_OUT_ERROR_MESSAGE);
    expect(html).toContain('id="nav-sign-out-retry"');
    expect(html).toContain("Retry");

    const retryOk = await performKibitzSignOut({
      logout: () =>
        logoutKibitzSession({
          fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        }),
      onSuccess: () => {
        currentUser = null;
        signOutError = null;
      },
      onFailure: (message) => {
        signOutError = message;
      },
    });

    expect(retryOk).toBe(true);
    expect(currentUser).toBeNull();
    expect(signOutError).toBeNull();
  });
});
