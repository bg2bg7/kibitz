import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AppShell,
  CURATED_STUDENT_EMOJIS,
  EmojiReactionBar,
  KibitzAuthMenu,
  KibitzLogo,
  KibitzSignOutErrorBanner,
  SIGN_OUT_ERROR_MESSAGE,
  SUITE_SERVICES,
  fetchKibitzSession,
  isAllowedSuiteUrl,
  logoutKibitzSession,
  performKibitzSignOut,
  pullReadOnlyFromService,
  resolveApiUrl,
  resolveServiceUrl,
  type KibitzSessionUser,
} from "./index.js";

describe("@suite/ui", () => {
  it("renders EmojiReactionBar with curated fixed buttons and zero text inputs", () => {
    const html = renderToStaticMarkup(createElement(EmojiReactionBar, { selected: "lightbulb" }));
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<textarea");
    expect(CURATED_STUDENT_EMOJIS.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain('aria-pressed="true"');
  });

  it("renders AppShell with subdomain, privacy badge, headerRight, and optional Kibitz home link", () => {
    const html = renderToStaticMarkup(
      createElement(AppShell, {
        appName: "Arbiter",
        subdomain: "arbiter.kibitz.local",
        badge: "100% Offline PWA",
        homeHref: "http://localhost:5170",
        headerRight: createElement("span", null, "CustomAction"),
        children: createElement("div", null, "Body"),
      }),
    );
    expect(html).toContain("Arbiter");
    expect(html).toContain("100% Offline PWA");
    expect(html).toContain("CustomAction");
    expect(html).toContain('href="http://localhost:5170"');
    expect(html).toContain("Kibitz");
  });

  it("renders KibitzAuthMenu in both unauthenticated and authenticated states", () => {
    const signedOutHtml = renderToStaticMarkup(createElement(KibitzAuthMenu, { user: null }));
    expect(signedOutHtml).toContain('id="nav-sign-in"');
    expect(signedOutHtml).toContain("Sign in");

    const signedInHtml = renderToStaticMarkup(
      createElement(KibitzAuthMenu, {
        user: {
          sub: "11111111-1111-4111-8111-111111111111",
          handle: "coach_alice",
          role: "coach",
          programIds: [],
          iat: 100,
          exp: 9999999999,
        },
        accountHref: "http://localhost:5172/@coach_alice",
      }),
    );
    expect(signedInHtml).toContain("@coach_alice");
    expect(signedInHtml).toContain("coach");
    expect(signedInHtml).toContain('id="nav-sign-out"');
    expect(signedInHtml).toContain('href="http://localhost:5172/@coach_alice"');
  });

  it("preserves signed-in state and exposes error/retry when logout fails, clearing only on success (ID-05)", async () => {
    const activeUser: KibitzSessionUser = {
      sub: "11111111-1111-4111-8111-111111111111",
      handle: "coach_alice",
      role: "coach",
      programIds: [],
      iat: 100,
      exp: 9999999999,
    };

    let currentUser: KibitzSessionUser | null = activeUser;
    let signOutError: string | null = null;
    let signingOut = false;
    const sessionNotifications: Array<KibitzSessionUser | null> = [];

    // 1. Server error (HTTP 500) -> logoutKibitzSession returns false -> user stays signed in
    const failingFetch: typeof fetch = async () => new Response(null, { status: 500 });
    const failedResult = await performKibitzSignOut({
      logout: () => logoutKibitzSession({ fetchImpl: failingFetch }),
      onStart: () => {
        signingOut = true;
        signOutError = null;
      },
      onSuccess: () => {
        currentUser = null;
        signOutError = null;
        sessionNotifications.push(null);
      },
      onFailure: (msg) => {
        signOutError = msg;
      },
      onFinally: () => {
        signingOut = false;
      },
    });

    expect(failedResult).toBe(false);
    expect(currentUser).toEqual(activeUser);
    expect(sessionNotifications).toEqual([]);
    expect(signOutError).toBe(SIGN_OUT_ERROR_MESSAGE);
    expect(signingOut).toBe(false);

    // Verify rendered error alert & Retry button markup
    const alertHtml = renderToStaticMarkup(
      createElement(KibitzSignOutErrorBanner, {
        message: signOutError ?? "",
        retrying: false,
        onRetry: () => {},
      }),
    );
    expect(alertHtml).toContain('role="alert"');
    expect(alertHtml).toContain(SIGN_OUT_ERROR_MESSAGE);
    expect(alertHtml).toContain('id="nav-sign-out-retry"');
    expect(alertHtml).toContain("Retry");

    const retryingHtml = renderToStaticMarkup(
      createElement(KibitzSignOutErrorBanner, {
        message: SIGN_OUT_ERROR_MESSAGE,
        retrying: true,
        onRetry: () => {},
      }),
    );
    expect(retryingHtml).toContain("disabled");

    // 2. Network error -> logoutKibitzSession returns false -> user still stays signed in
    const throwingFetch: typeof fetch = async () => {
      throw new Error("network offline");
    };
    const networkFailed = await performKibitzSignOut({
      logout: () => logoutKibitzSession({ fetchImpl: throwingFetch }),
      onStart: () => {
        signingOut = true;
        signOutError = null;
      },
      onSuccess: () => {
        currentUser = null;
        sessionNotifications.push(null);
      },
      onFailure: (msg) => {
        signOutError = msg;
      },
      onFinally: () => {
        signingOut = false;
      },
    });

    expect(networkFailed).toBe(false);
    expect(currentUser).toEqual(activeUser);
    expect(sessionNotifications).toEqual([]);
    expect(signOutError).toBe(SIGN_OUT_ERROR_MESSAGE);

    // 3. Retry succeeds (HTTP 200) -> clears user & error and notifies session change
    const okFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 });
    const retryResult = await performKibitzSignOut({
      logout: () => logoutKibitzSession({ fetchImpl: okFetch }),
      onStart: () => {
        signingOut = true;
        signOutError = null;
      },
      onSuccess: () => {
        currentUser = null;
        signOutError = null;
        sessionNotifications.push(null);
      },
      onFailure: (msg) => {
        signOutError = msg;
      },
      onFinally: () => {
        signingOut = false;
      },
    });

    expect(retryResult).toBe(true);
    expect(currentUser).toBeNull();
    expect(signOutError).toBeNull();
    expect(signingOut).toBe(false);
    expect(sessionNotifications).toEqual([null]);
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
    expect(SUITE_SERVICES.find((s) => s.id === "lecture")?.status).toBe("available");

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
