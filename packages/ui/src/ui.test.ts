import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AccessibleDialog,
  AppShell,
  CURATED_STUDENT_EMOJIS,
  EmojiReactionBar,
  KibitzAuthMenu,
  KibitzLogo,
  KibitzSignOutErrorBanner,
  SIGN_OUT_ERROR_MESSAGE,
  SUITE_SERVICES,
  fetchKibitzSession,
  focusInitialDialogElement,
  getFocusableElements,
  handleDialogKeyDown,
  isAllowedSuiteUrl,
  logoutKibitzSession,
  performKibitzSignOut,
  pullReadOnlyFromService,
  resolveApiUrl,
  resolveServiceUrl,
  restoreDialogFocus,
  trapFocusInDialog,
  type DialogKeyEventLike,
  type FocusTrapContainerLike,
  type FocusableElementLike,
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

  describe("AccessibleDialog (UI-03)", () => {
    const createMockFocusable = (opts?: {
      id?: string;
      disabled?: boolean;
      hidden?: boolean;
      tabIndex?: number;
      isConnected?: boolean;
      insideInert?: boolean;
    }): FocusableElementLike & { id: string; focusCalls: number } => {
      const node = {
        id: opts?.id ?? "el",
        focusCalls: 0,
        tabIndex: opts?.tabIndex ?? 0,
        isConnected: opts?.isConnected ?? true,
        focus() {
          node.focusCalls += 1;
        },
        hasAttribute(name: string) {
          if (name === "disabled") return Boolean(opts?.disabled);
          if (name === "hidden") return Boolean(opts?.hidden);
          return false;
        },
        closest() {
          return opts?.insideInert ? {} : null;
        },
      };
      return node;
    };

    const createMockPanel = (
      children: FocusableElementLike[],
    ): FocusTrapContainerLike & { focusCalls: number } => {
      const panel = {
        focusCalls: 0,
        tabIndex: -1,
        focus() {
          panel.focusCalls += 1;
        },
        querySelectorAll() {
          return children;
        },
        contains(target: unknown) {
          return target === panel || children.includes(target as FocusableElementLike);
        },
      };
      return panel;
    };

    const createMockKeyEvent = (
      key: string,
      shiftKey = false,
    ): DialogKeyEventLike & {
      defaultPrevented: boolean;
      propagationStopped: boolean;
      immediatePropagationStopped: boolean;
    } => {
      const ev = {
        key,
        shiftKey,
        defaultPrevented: false,
        propagationStopped: false,
        immediatePropagationStopped: false,
        preventDefault() {
          ev.defaultPrevented = true;
        },
        stopPropagation() {
          ev.propagationStopped = true;
        },
        stopImmediatePropagation() {
          ev.immediatePropagationStopped = true;
        },
      };
      return ev;
    };

    it("renders nothing when closed and renders accessible dialog attributes and classes when open", () => {
      const closedHtml = renderToStaticMarkup(
        createElement(AccessibleDialog, {
          open: false,
          onClose: () => {},
          ariaLabelledBy: "dlg-title",
          children: createElement("h2", { id: "dlg-title" }, "Hidden"),
        }),
      );
      expect(closedHtml).toBe("");

      const tailwindHtml = renderToStaticMarkup(
        createElement(AccessibleDialog, {
          open: true,
          onClose: () => {},
          ariaLabelledBy: "dlg-title",
          ariaDescribedBy: "dlg-desc",
          overlayClassName: "fixed inset-0 bg-slate-950/45",
          panelClassName: "max-w-md rounded-2xl bg-white",
          className: "p-6",
          testId: "sample-dialog",
          children: [
            createElement("h2", { key: "t", id: "dlg-title" }, "Dialog Title"),
            createElement("p", { key: "d", id: "dlg-desc" }, "Dialog description"),
          ],
        }),
      );

      expect(tailwindHtml).toContain('role="dialog"');
      expect(tailwindHtml).toContain('aria-modal="true"');
      expect(tailwindHtml).toContain('aria-labelledby="dlg-title"');
      expect(tailwindHtml).toContain('aria-describedby="dlg-desc"');
      expect(tailwindHtml).toMatch(/tabindex="-1"/i);
      expect(tailwindHtml).toContain('data-testid="sample-dialog"');
      expect(tailwindHtml).toContain('class="fixed inset-0 bg-slate-950/45"');
      expect(tailwindHtml).toContain('class="max-w-md rounded-2xl bg-white p-6"');
      // Does not inject conflicting inline overlay style when overlayClassName is supplied
      expect(tailwindHtml).not.toContain("position:fixed");

      const styledHtml = renderToStaticMarkup(
        createElement(AccessibleDialog, {
          open: true,
          onClose: () => {},
          ariaLabel: "Inline Styled Dialog",
          style: { zIndex: 200 },
          panelStyle: { maxWidth: "28rem" },
          children: createElement("span", null, "Body"),
        }),
      );
      expect(styledHtml).toContain('aria-label="Inline Styled Dialog"');
      expect(styledHtml).toContain("z-index:200");
      expect(styledHtml).toContain("max-width:28rem");
    });

    it("transfers initial focus to preferred target, first focusable element, or panel fallback", () => {
      const disabledBtn = createMockFocusable({ id: "disabled", disabled: true });
      const hiddenBtn = createMockFocusable({ id: "hidden", hidden: true });
      const inertBtn = createMockFocusable({ id: "inert", insideInert: true });
      const first = createMockFocusable({ id: "first" });
      const second = createMockFocusable({ id: "second" });
      const panel = createMockPanel([disabledBtn, hiddenBtn, inertBtn, first, second]);

      expect(getFocusableElements(panel)).toEqual([first, second]);

      // Default focuses first visible focusable element
      expect(focusInitialDialogElement(panel)).toBe(first);
      expect(first.focusCalls).toBe(1);

      // Preferred target overrides default when focusable
      expect(focusInitialDialogElement(panel, second)).toBe(second);
      expect(second.focusCalls).toBe(1);

      // Falls back to dialog panel itself when no focusable children exist
      const emptyPanel = createMockPanel([disabledBtn]);
      expect(focusInitialDialogElement(emptyPanel)).toBe(emptyPanel);
      expect(emptyPanel.focusCalls).toBe(1);
    });

    it("traps Tab and Shift+Tab within the dialog container", () => {
      const first = createMockFocusable({ id: "first" });
      const middle = createMockFocusable({ id: "middle" });
      const last = createMockFocusable({ id: "last" });
      const outside = createMockFocusable({ id: "outside" });
      const panel = createMockPanel([first, middle, last]);

      // Tab on last wraps to first
      const tabOnLast = createMockKeyEvent("Tab", false);
      expect(trapFocusInDialog(panel, tabOnLast, last)).toBe(first);
      expect(tabOnLast.defaultPrevented).toBe(true);
      expect(first.focusCalls).toBe(1);

      // Shift+Tab on first wraps to last
      const shiftTabOnFirst = createMockKeyEvent("Tab", true);
      expect(trapFocusInDialog(panel, shiftTabOnFirst, first)).toBe(last);
      expect(shiftTabOnFirst.defaultPrevented).toBe(true);
      expect(last.focusCalls).toBe(1);

      // Shift+Tab on dialog panel itself wraps to last
      const shiftTabOnPanel = createMockKeyEvent("Tab", true);
      expect(trapFocusInDialog(panel, shiftTabOnPanel, panel)).toBe(last);
      expect(shiftTabOnPanel.defaultPrevented).toBe(true);
      expect(last.focusCalls).toBe(2);

      // Tab on middle does NOT preventDefault (native movement inside dialog)
      const tabOnMiddle = createMockKeyEvent("Tab", false);
      expect(trapFocusInDialog(panel, tabOnMiddle, middle)).toBeNull();
      expect(tabOnMiddle.defaultPrevented).toBe(false);

      // Focus escaped outside dialog -> Tab brings focus back to first, Shift+Tab to last
      const tabOutside = createMockKeyEvent("Tab", false);
      expect(trapFocusInDialog(panel, tabOutside, outside)).toBe(first);
      expect(tabOutside.defaultPrevented).toBe(true);
      expect(first.focusCalls).toBe(2);

      const shiftTabOutside = createMockKeyEvent("Tab", true);
      expect(trapFocusInDialog(panel, shiftTabOutside, outside)).toBe(last);
      expect(shiftTabOutside.defaultPrevented).toBe(true);
      expect(last.focusCalls).toBe(3);

      // Dialog with zero focusable children keeps focus on panel
      const emptyPanel = createMockPanel([]);
      const tabEmpty = createMockKeyEvent("Tab", false);
      expect(trapFocusInDialog(emptyPanel, tabEmpty, emptyPanel)).toBe(emptyPanel);
      expect(tabEmpty.defaultPrevented).toBe(true);
      expect(emptyPanel.focusCalls).toBe(1);
    });

    it("handles Escape by closing and stopping propagation so background shortcuts do not fire", () => {
      const first = createMockFocusable({ id: "first" });
      const last = createMockFocusable({ id: "last" });
      const panel = createMockPanel([first, last]);
      const onClose = vi.fn();

      const escapeEv = createMockKeyEvent("Escape");
      expect(
        handleDialogKeyDown(escapeEv, { panel, onClose, activeElement: first }),
      ).toBe("escape");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(escapeEv.defaultPrevented).toBe(true);
      expect(escapeEv.propagationStopped).toBe(true);
      expect(escapeEv.immediatePropagationStopped).toBe(true);

      // Unrelated key is ignored
      const enterEv = createMockKeyEvent("Enter");
      expect(
        handleDialogKeyDown(enterEv, { panel, onClose, activeElement: first }),
      ).toBeNull();
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(enterEv.defaultPrevented).toBe(false);

      // Tab delegates to trapFocusInDialog
      const tabEv = createMockKeyEvent("Tab");
      expect(
        handleDialogKeyDown(tabEv, { panel, onClose, activeElement: last }),
      ).toBe("tab");
      expect(tabEv.defaultPrevented).toBe(true);
      expect(first.focusCalls).toBe(1);
    });

    it("restores focus to connected trigger elements and skips disconnected or null elements", () => {
      const trigger = createMockFocusable({ id: "trigger", isConnected: true });
      const detached = createMockFocusable({ id: "detached", isConnected: false });

      expect(restoreDialogFocus(trigger)).toBe(true);
      expect(trigger.focusCalls).toBe(1);

      expect(restoreDialogFocus(detached)).toBe(false);
      expect(detached.focusCalls).toBe(0);

      expect(restoreDialogFocus(null)).toBe(false);
    });
  });
});
