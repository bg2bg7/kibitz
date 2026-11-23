import { describe, expect, it } from "vitest";
import { createLectureApp } from "./app.js";

describe("@suite/lecture server", () => {
  it("exposes /health and open public primers while requiring auth for assignments", async () => {
    const app = createLectureApp();

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "lecture" });

    const primers = await app.request("/api/primers");
    expect(primers.status).toBe(200);

    const assignmentsUnauth = await app.request("/api/assignments");
    expect(assignmentsUnauth.status).toBe(401);
  });
});
