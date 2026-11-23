import { resolveAuthConfig, signSessionToken } from "@suite/auth-core";
import { describe, expect, it } from "vitest";
import { createLectureApp } from "./app.js";

describe("@suite/lecture server", () => {
  it("exposes /health and open public primers while verifying KibitzID sessions for assignments", async () => {
    const authConfig = resolveAuthConfig({
      AUTH_JWT_SECRET: "shared-cross-service-test-secret-over-32-bytes",
    });
    const app = createLectureApp({ authConfig });

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "lecture" });

    const primers = await app.request("/api/primers");
    expect(primers.status).toBe(200);

    const assignmentsUnauth = await app.request("/api/assignments");
    expect(assignmentsUnauth.status).toBe(401);

    const { token } = await signSessionToken(
      {
        sub: "11111111-1111-4111-8111-111111111111",
        handle: "student_bob",
        role: "student",
        programIds: [],
      },
      authConfig,
    );

    const assignmentsViaCookie = await app.request("/api/assignments", {
      headers: {
        cookie: `kibitz_session=${token}`,
        origin: "http://localhost:5172",
      },
    });
    expect(assignmentsViaCookie.status).toBe(200);
    expect(assignmentsViaCookie.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5172",
    );
    expect(assignmentsViaCookie.headers.get("access-control-allow-credentials")).toBe("true");
    const body = (await assignmentsViaCookie.json()) as {
      viewer: { handle: string; role: string };
      interactionPolicy: string;
    };
    expect(body.viewer.handle).toBe("student_bob");
    expect(body.interactionPolicy).toBe("emoji_only");
  });
});
