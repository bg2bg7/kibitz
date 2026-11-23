import { hashPassword, resolveAuthConfig, signSessionToken } from "@suite/auth-core";
import { describe, expect, it } from "vitest";
import { createIdApp } from "./app.js";
import { InMemoryIdentityRepository } from "./repository.js";

function extractCookiePair(setCookieHeader: string | null): string {
  if (!setCookieHeader) {
    throw new Error("Expected Set-Cookie header");
  }
  return setCookieHeader.split(";")[0] ?? "";
}

async function setupTestIdApp() {
  const repo = new InMemoryIdentityRepository();
  const adminHash = await hashPassword("admin-secret-passphrase", 4);
  repo.seedUser({
    handle: "admin",
    passwordHash: adminHash,
    role: "admin",
  });
  const authConfig = resolveAuthConfig({
    AUTH_JWT_SECRET: "test-secret-with-at-least-thirty-two-bytes-length",
    AUTH_COOKIE_DOMAIN: "localhost",
  });
  const app = createIdApp({ repository: repo, authConfig, bcryptCost: 4 });
  return { app, repo, authConfig };
}

describe("@suite/id server", () => {
  it("exposes /health with invite-only status", async () => {
    const { app } = await setupTestIdApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      service: "id",
      registrationMode: "invite-only",
    });
  });

  it("supports login, cross-service session cookie, CORS credentials, and logout", async () => {
    const { app } = await setupTestIdApp();

    const anonSession = await app.request("/auth/session");
    expect(anonSession.status).toBe(200);
    expect(await anonSession.json()).toEqual({ authenticated: false, user: null });

    const badLogin = await app.request("/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5170",
      },
      body: JSON.stringify({ handle: "admin", password: "wrong-password" }),
    });
    expect(badLogin.status).toBe(401);

    const loginRes = await app.request("/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5170",
      },
      body: JSON.stringify({ handle: "ADMIN", password: "admin-secret-passphrase" }),
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.headers.get("access-control-allow-origin")).toBe("http://localhost:5170");
    expect(loginRes.headers.get("access-control-allow-credentials")).toBe("true");

    const setCookie = loginRes.headers.get("set-cookie");
    expect(setCookie).toContain("kibitz_session=");
    expect(setCookie).toContain("HttpOnly");
    const cookieHeader = extractCookiePair(setCookie);

    // Offline PWA origin (:5175 arbiter) can read session via credentials: include
    const sessionRes = await app.request("/auth/session", {
      headers: {
        cookie: cookieHeader,
        origin: "http://localhost:5175",
      },
    });
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.headers.get("access-control-allow-origin")).toBe("http://localhost:5175");
    const sessionBody = (await sessionRes.json()) as {
      authenticated: boolean;
      user: { handle: string; role: string } | null;
    };
    expect(sessionBody.authenticated).toBe(true);
    expect(sessionBody.user?.handle).toBe("admin");
    expect(sessionBody.user?.role).toBe("admin");

    // Rejects untrusted cross-origin POST
    const evilPost = await app.request("/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.example.com" },
    });
    expect(evilPost.status).toBe(403);

    const logoutRes = await app.request("/auth/logout", {
      method: "POST",
      headers: { origin: "http://localhost:5170" },
    });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("enforces invite-only registration, role restrictions, and single-use invite quotas", async () => {
    const { app } = await setupTestIdApp();

    const adminLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "admin", password: "admin-secret-passphrase" }),
    });
    const adminCookie = extractCookiePair(adminLogin.headers.get("set-cookie"));

    // Admin issues a single-use coach invite
    const coachInviteRes = await app.request("/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ assignedRole: "coach", maxUses: 1 }),
    });
    expect(coachInviteRes.status).toBe(201);
    const { invite: coachInvite } = (await coachInviteRes.json()) as {
      invite: { code: string; assignedRole: string };
    };
    expect(coachInvite.assignedRole).toBe("coach");

    // Registration without valid invite fails
    const badReg = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: "KBZ-FAKE-CODE",
        handle: "coach_alice",
        password: "strong-coach-password",
      }),
    });
    expect(badReg.status).toBe(400);

    // Registration with valid invite succeeds and sets session cookie
    const regRes = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: coachInvite.code,
        handle: "coach_alice",
        password: "strong-coach-password",
      }),
    });
    expect(regRes.status).toBe(201);
    const coachCookie = extractCookiePair(regRes.headers.get("set-cookie"));

    // Reusing exhausted single-use invite fails
    const reuseRes = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: coachInvite.code,
        handle: "coach_other",
        password: "strong-coach-password",
      }),
    });
    expect(reuseRes.status).toBe(400);

    // Coach cannot issue admin invites, but can issue student invites
    const forbiddenInvite = await app.request("/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: coachCookie },
      body: JSON.stringify({ assignedRole: "admin", maxUses: 1 }),
    });
    expect(forbiddenInvite.status).toBe(403);

    const studentInviteRes = await app.request("/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: coachCookie },
      body: JSON.stringify({ assignedRole: "student", maxUses: 2 }),
    });
    expect(studentInviteRes.status).toBe(201);
  });

  it("returns strictly identical 202 responses for double-blind /links/intent and activates only on reciprocal match", async () => {
    const { app, repo } = await setupTestIdApp();
    const passHash = await hashPassword("shared-test-passphrase", 4);
    const coach = repo.seedUser({ handle: "coach_alice", passwordHash: passHash, role: "coach" });
    const student = repo.seedUser({
      handle: "student_bob",
      passwordHash: passHash,
      role: "student",
    });

    const coachLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: coach.handle, password: "shared-test-passphrase" }),
    });
    const coachCookie = extractCookiePair(coachLogin.headers.get("set-cookie"));

    const studentLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: student.handle, password: "shared-test-passphrase" }),
    });
    const studentCookie = extractCookiePair(studentLogin.headers.get("set-cookie"));

    const firstRes = await app.request("/links/intent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: coachCookie },
      body: JSON.stringify({ targetHandle: "student_bob" }),
    });

    const missingTargetRes = await app.request("/links/intent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: coachCookie },
      body: JSON.stringify({ targetHandle: "nonexistent_user" }),
    });

    // Before reciprocal intent, neither user sees any active links
    const linksBefore = (await (
      await app.request("/links", { headers: { cookie: coachCookie } })
    ).json()) as { links: unknown[] };
    expect(linksBefore.links).toHaveLength(0);

    const reciprocalRes = await app.request("/links/intent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: studentCookie },
      body: JSON.stringify({ targetHandle: "COACH_ALICE" }),
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

    // After reciprocal intent, both users see the active mutual link
    const coachLinks = (await (
      await app.request("/links", { headers: { cookie: coachCookie } })
    ).json()) as { links: Array<{ peerUserId: string; peerHandle: string; relation: string }> };
    expect(coachLinks.links).toHaveLength(1);
    expect(coachLinks.links[0]?.peerHandle).toBe("student_bob");
    expect(coachLinks.links[0]?.relation).toBe("student");

    // Revoking link removes it for both sides
    const revokeRes = await app.request(`/links/${student.id}`, {
      method: "DELETE",
      headers: { cookie: coachCookie },
    });
    expect(revokeRes.status).toBe(200);

    const studentLinksAfter = (await (
      await app.request("/links", { headers: { cookie: studentCookie } })
    ).json()) as { links: unknown[] };
    expect(studentLinksAfter.links).toHaveLength(0);
  });

  it("rejects and clears stale session cookies whose sub UUID no longer exists in users", async () => {
    const { app, authConfig } = await setupTestIdApp();
    const { token: staleToken } = await signSessionToken(
      {
        sub: "99999999-9999-4999-8999-999999999999",
        handle: "admin",
        role: "admin",
        programIds: [],
      },
      authConfig,
    );

    const sessionRes = await app.request("/auth/session", {
      headers: { cookie: `kibitz_session=${staleToken}` },
    });
    expect(sessionRes.status).toBe(200);
    expect(await sessionRes.json()).toEqual({ authenticated: false, user: null });
    expect(sessionRes.headers.get("set-cookie")).toContain("kibitz_session=");
    expect(sessionRes.headers.get("set-cookie")).toContain("Max-Age=0");

    const invitesRes = await app.request("/invites", {
      headers: { cookie: `kibitz_session=${staleToken}` },
    });
    expect(invitesRes.status).toBe(401);
    expect(invitesRes.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
