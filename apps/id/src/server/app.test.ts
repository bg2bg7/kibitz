import { describe, expect, it } from "vitest";
import { createIdApp } from "./app.js";

describe("@suite/id server", () => {
  it("exposes /health with invite-only status", async () => {
    const app = createIdApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      service: "id",
      registrationMode: "invite-only",
    });
  });

  it("returns strictly identical 202 responses for double-blind /links/intent regardless of match", async () => {
    const app = createIdApp();

    const firstRes = await app.request("/links/intent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stub-user-id": "coach-1",
        "x-stub-handle": "coach_alice",
      },
      body: JSON.stringify({ targetHandle: "student_bob" }),
    });

    const missingTargetRes = await app.request("/links/intent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stub-user-id": "coach-1",
        "x-stub-handle": "coach_alice",
      },
      body: JSON.stringify({ targetHandle: "nonexistent_user" }),
    });

    const reciprocalRes = await app.request("/links/intent", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-stub-user-id": "student-1",
        "x-stub-handle": "student_bob",
      },
      body: JSON.stringify({ targetHandle: "coach_alice" }),
    });

    expect(firstRes.status).toBe(202);
    expect(missingTargetRes.status).toBe(202);
    expect(reciprocalRes.status).toBe(202);

    const [firstBody, missingBody, reciprocalBody] = await Promise.all([
      firstRes.json(),
      missingTargetRes.json(),
      reciprocalRes.json(),
    ]);

    expect(firstBody).toEqual(missingBody);
    expect(firstBody).toEqual(reciprocalBody);
  });
});
