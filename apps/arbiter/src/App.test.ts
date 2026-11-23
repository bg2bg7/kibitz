import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { pullReadOnlyFromService } from "@suite/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("@suite/arbiter shell", () => {
  it("renders Hello World placeholder with 100% Offline PWA badge and link back to Kibitz homepage", () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("Hello, World!");
    expect(html).toContain("100% Offline PWA");
    expect(html).toContain('href="http://localhost:5170"');
  });

  it("emits zero outbound network requests during offline render", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected network request from offline Arbiter app"));

    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain("Hello, World!");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("enforces strictly read-only GET with zero body when using pullReadOnlyFromService", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tournaments: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await pullReadOnlyFromService<{ tournaments: unknown[] }>(
      "hall",
      "/api/tournaments",
    );

    expect(result).toEqual({ ok: true, status: 200, data: { tournaments: [] } });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/api\/tournaments$/);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.credentials).toBe("include");
  });

  it("handles offline pullReadOnlyFromService failures gracefully without throwing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await pullReadOnlyFromService<{ tournaments: unknown[] }>(
      "hall",
      "/api/tournaments",
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: false,
      status: 0,
      error: "Offline or service unreachable.",
    });
  });
});
