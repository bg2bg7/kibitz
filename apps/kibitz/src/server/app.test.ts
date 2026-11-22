import { describe, expect, it } from "vitest";
import { createKibitzApp } from "./app.js";

describe("@suite/kibitz server", () => {
  it("exposes /health and open public primers while requiring auth for assignments", async () => {
    const app = createKibitzApp();

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "kibitz" });

    const primers = await app.request("/api/primers");
    expect(primers.status).toBe(200);

    const assignmentsUnauth = await app.request("/api/assignments");
    expect(assignmentsUnauth.status).toBe(401);
  });
});
