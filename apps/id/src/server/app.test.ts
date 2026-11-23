import {
  OPAQUE_LINK_INTENT_RESPONSE,
  hashPassword,
  resolveAuthConfig,
  signSessionToken,
} from "@suite/auth-core";
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

  it("enforces bcrypt's 72-byte UTF-8 password boundary on POST /auth/register", async () => {
    const { app } = await setupTestIdApp();

    const adminLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "admin", password: "admin-secret-passphrase" }),
    });
    const adminCookie = extractCookiePair(adminLogin.headers.get("set-cookie"));

    const inviteRes = await app.request("/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ assignedRole: "student", maxUses: 4 }),
    });
    expect(inviteRes.status).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { code: string } };

    // Exact 72 ASCII bytes succeeds
    const ascii72Res = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: invite.code,
        handle: "student_ascii72",
        password: "a".repeat(72),
      }),
    });
    expect(ascii72Res.status).toBe(201);

    // Exact 72 UTF-8 bytes with 3-byte euro signs (24 * 3 = 72) succeeds
    const euro72Res = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: invite.code,
        handle: "student_euro72",
        password: "€".repeat(24),
      }),
    });
    expect(euro72Res.status).toBe(201);

    // 73 ASCII bytes is rejected with 400 mentioning 72 bytes
    const ascii73Res = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: invite.code,
        handle: "student_ascii73",
        password: "a".repeat(73),
      }),
    });
    expect(ascii73Res.status).toBe(400);
    const ascii73Body = (await ascii73Res.json()) as { error: string };
    expect(ascii73Body.error).toMatch(/72.*bytes/i);

    // 76 UTF-8 bytes using 4-byte emoji (19 * 4 = 76) is rejected with 400 mentioning 72 bytes
    const emoji76Res = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: invite.code,
        handle: "student_emoji76",
        password: "🔑".repeat(19),
      }),
    });
    expect(emoji76Res.status).toBe(400);
    const emoji76Body = (await emoji76Res.json()) as { error: string };
    expect(emoji76Body.error).toMatch(/72.*bytes/i);
  });

  it("ID-01: enforces program invite authority across two programs and invalidates outstanding invites after authority loss", async () => {
    const { app, repo } = await setupTestIdApp();
    const passHash = await hashPassword("shared-test-passphrase", 4);
    const admin = (await repo.findUserByHandle("admin"))!;

    const programA = repo.seedProgram({ name: "Program A", ownerUserId: admin.id });
    const programB = repo.seedProgram({ name: "Program B", ownerUserId: admin.id });

    const coachA = repo.seedUser({
      handle: "coach_a",
      passwordHash: passHash,
      role: "coach",
    });
    repo.addProgramMembership({ programId: programA.id, userId: coachA.id, role: "coach" });

    const adminLogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "admin", password: "admin-secret-passphrase" }),
    });
    const adminCookie = extractCookiePair(adminLogin.headers.get("set-cookie"));

    const coachALogin = await app.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "coach_a", password: "shared-test-passphrase" }),
    });
    const coachACookie = extractCookiePair(coachALogin.headers.get("set-cookie"));

    // Coach A CAN issue student invite for Program A
    const validProgAInviteRes = await app.request("/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: coachACookie },
      body: JSON.stringify({ assignedRole: "student", programId: programA.id, maxUses: 2 }),
    });
    expect(validProgAInviteRes.status).toBe(201);
    const { invite: progAInvite } = (await validProgAInviteRes.json()) as {
      invite: { code: string; programId: string | null };
    };
    expect(progAInvite.programId).toBe(programA.id);

    // Coach A CANNOT issue coach invite for Program A (403)
    const forbiddenCoachRoleRes = await app.request("/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: coachACookie },
      body: JSON.stringify({ assignedRole: "coach", programId: programA.id, maxUses: 1 }),
    });
    expect(forbiddenCoachRoleRes.status).toBe(403);

    // Coach A CANNOT issue student invite for Program B (403), leaves no invite
    const invitesBeforeB = await repo.listInvites({ createdByUserId: coachA.id });
    const forbiddenProgBRes = await app.request("/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: coachACookie },
      body: JSON.stringify({ assignedRole: "student", programId: programB.id, maxUses: 1 }),
    });
    expect(forbiddenProgBRes.status).toBe(403);
    const invitesAfterB = await repo.listInvites({ createdByUserId: coachA.id });
    expect(invitesAfterB).toHaveLength(invitesBeforeB.length);

    // Non-existent target program returns 404 without creating an invite
    const missingProgramRes = await app.request("/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        assignedRole: "student",
        programId: "11111111-1111-4111-8111-111111111111",
        maxUses: 1,
      }),
    });
    expect(missingProgramRes.status).toBe(404);

    // Admin CAN issue both coach and student invites for Program B
    const adminCoachBRes = await app.request("/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ assignedRole: "coach", programId: programB.id, maxUses: 1 }),
    });
    expect(adminCoachBRes.status).toBe(201);

    const adminStudentBRes = await app.request("/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ assignedRole: "student", programId: programB.id, maxUses: 1 }),
    });
    expect(adminStudentBRes.status).toBe(201);

    // While Coach A still has authority in Program A, redeeming progAInvite succeeds and enrolls student
    const firstRedeemRes = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: progAInvite.code,
        handle: "student_a1",
        password: "strong-student-pass",
      }),
    });
    expect(firstRedeemRes.status).toBe(201);
    const firstStudent = await repo.findUserByHandle("student_a1");
    expect(firstStudent).not.toBeNull();
    expect(await repo.getUserProgramIds(firstStudent!.id)).toEqual([programA.id]);

    // Revoke Coach A's Program A membership before the second use of progAInvite is redeemed
    repo.removeProgramMembership(coachA.id, programA.id);

    const postRevokeRedeemRes = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: progAInvite.code,
        handle: "student_a2",
        password: "strong-student-pass",
      }),
    });
    expect(postRevokeRedeemRes.status).toBe(400);
    // Neither user nor membership was created, and invite usedCount did not increment
    expect(await repo.findUserByHandle("student_a2")).toBeNull();
    const updatedInvite = (await repo.listInvites({ createdByUserId: coachA.id })).find(
      (i) => i.code === progAInvite.code,
    );
    expect(updatedInvite?.usedCount).toBe(1);
  });

  it("ID-02: serializes concurrent reciprocal link intents, deduplicates on active links, and requires fresh mutual consent after revocation", async () => {
    const { app, repo } = await setupTestIdApp();
    const passHash = await hashPassword("shared-test-passphrase", 4);
    const coach = repo.seedUser({ handle: "coach_pair", passwordHash: passHash, role: "coach" });
    const student = repo.seedUser({
      handle: "student_pair",
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

    // Concurrent reciprocal submissions yield one active link with identical 202 responses
    const [resA, resB] = await Promise.all([
      app.request("/links/intent", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: coachCookie },
        body: JSON.stringify({ targetHandle: "student_pair" }),
      }),
      app.request("/links/intent", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: studentCookie },
        body: JSON.stringify({ targetHandle: "coach_pair" }),
      }),
    ]);

    expect(resA.status).toBe(202);
    expect(resB.status).toBe(202);
    const bodyA = await resA.json();
    const bodyB = await resB.json();
    expect(bodyA).toEqual(OPAQUE_LINK_INTENT_RESPONSE);
    expect(bodyB).toEqual(OPAQUE_LINK_INTENT_RESPONSE);

    const coachLinksAfterMatch = (await (
      await app.request("/links", { headers: { cookie: coachCookie } })
    ).json()) as { links: Array<{ peerUserId: string }> };
    const studentLinksAfterMatch = (await (
      await app.request("/links", { headers: { cookie: studentCookie } })
    ).json()) as { links: Array<{ peerUserId: string }> };
    expect(coachLinksAfterMatch.links).toHaveLength(1);
    expect(studentLinksAfterMatch.links).toHaveLength(1);

    // Submitting a redundant intent while already active must NOT create a stale pending intent
    const redundantRes = await app.request("/links/intent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: coachCookie },
      body: JSON.stringify({ targetHandle: "student_pair" }),
    });
    expect(redundantRes.status).toBe(202);
    expect(await redundantRes.json()).toEqual(bodyA);

    // Revoking active link removes link and clears any intents in either direction
    const revokeRes = await app.request(`/links/${student.id}`, {
      method: "DELETE",
      headers: { cookie: coachCookie },
    });
    expect(revokeRes.status).toBe(200);

    // A single-sided intent after revocation must NEVER restore access
    const singlePostRevokeRes = await app.request("/links/intent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: studentCookie },
      body: JSON.stringify({ targetHandle: "coach_pair" }),
    });
    expect(singlePostRevokeRes.status).toBe(202);
    expect(await singlePostRevokeRes.json()).toEqual(bodyA);

    const linksAfterSingle = (await (
      await app.request("/links", { headers: { cookie: studentCookie } })
    ).json()) as { links: unknown[] };
    expect(linksAfterSingle.links).toHaveLength(0);

    // A second fresh reciprocal intent DOES restore access
    const freshReciprocalRes = await app.request("/links/intent", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: coachCookie },
      body: JSON.stringify({ targetHandle: "student_pair" }),
    });
    expect(freshReciprocalRes.status).toBe(202);
    expect(await freshReciprocalRes.json()).toEqual(bodyA);

    const linksAfterFreshMutual = (await (
      await app.request("/links", { headers: { cookie: coachCookie } })
    ).json()) as { links: Array<{ peerUserId: string }> };
    expect(linksAfterFreshMutual.links).toHaveLength(1);
    expect(linksAfterFreshMutual.links[0]?.peerUserId).toBe(student.id);
  });

  it("ID-03: prevents handle enumeration on ineligible invites, handles concurrent same-handle registration cleanly, and enforces auth rate limits", async () => {
    const { app, repo, authConfig } = await setupTestIdApp();
    const admin = (await repo.findUserByHandle("admin"))!;

    // Seed an expired invite and an exhausted invite directly
    const expiredInvite = await repo.createInvite({
      createdByUserId: admin.id,
      assignedRole: "student",
      maxUses: 1,
      expiresAt: new Date(Date.now() - 60_000),
    });
    const exhaustedInvite = await repo.createInvite({
      createdByUserId: admin.id,
      assignedRole: "student",
      maxUses: 1,
    });
    const firstUse = await app.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: exhaustedInvite.code,
        handle: "first_student",
        password: "strong-password-123",
      }),
    });
    expect(firstUse.status).toBe(201);

    // For invalid, expired, and exhausted invites, response must be identical for taken vs unused handles
    for (const code of ["KBZ-NOPE-0000-0000", expiredInvite.code, exhaustedInvite.code]) {
      const takenRes = await app.request("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inviteCode: code,
          handle: "admin", // already taken
          password: "strong-password-123",
        }),
      });
      const unusedRes = await app.request("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inviteCode: code,
          handle: "totally_unused_handle",
          password: "strong-password-123",
        }),
      });
      expect(takenRes.status).toBe(400);
      expect(unusedRes.status).toBe(400);
      expect(await takenRes.json()).toEqual(await unusedRes.json());
    }

    // Concurrent valid registrations for the same handle yield one 201 and one 409 with usedCount === 1
    const multiInvite = await repo.createInvite({
      createdByUserId: admin.id,
      assignedRole: "student",
      maxUses: 5,
    });

    const [race1, race2] = await Promise.all([
      app.request("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inviteCode: multiInvite.code,
          handle: "race_handle",
          password: "strong-password-123",
        }),
      }),
      app.request("/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inviteCode: multiInvite.code,
          handle: "RACE_HANDLE",
          password: "strong-password-456",
        }),
      }),
    ]);

    const statuses = [race1.status, race2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);

    const inviteAfterRace = (await repo.listInvites()).find((i) => i.code === multiInvite.code);
    expect(inviteAfterRace?.usedCount).toBe(1);

    // Rate limiter returns 429 when configured limit is exceeded
    const limitedApp = createIdApp({
      repository: repo,
      authConfig,
      bcryptCost: 4,
      authRateLimit: { maxAttempts: 2, windowMs: 60_000 },
    });

    const attempt1 = await limitedApp.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
      body: JSON.stringify({ handle: "admin", password: "wrong" }),
    });
    expect(attempt1.status).toBe(401);

    const attempt2 = await limitedApp.request("/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
      body: JSON.stringify({
        inviteCode: "KBZ-NOPE-0000-0000",
        handle: "some_user",
        password: "strong-password-123",
      }),
    });
    expect(attempt2.status).toBe(400);

    const attempt3 = await limitedApp.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" },
      body: JSON.stringify({ handle: "admin", password: "admin-secret-passphrase" }),
    });
    expect(attempt3.status).toBe(429);
    expect(await attempt3.json()).toEqual({
      error: "Too many authentication attempts. Please try again shortly.",
    });

    // Different client IP is not rate limited
    const otherIpAttempt = await limitedApp.request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.11" },
      body: JSON.stringify({ handle: "admin", password: "admin-secret-passphrase" }),
    });
    expect(otherIpAttempt.status).toBe(200);
  });

  it("ID-05: handles malformed percent-encoded session cookies cleanly without 500 errors", async () => {
    const { app } = await setupTestIdApp();

    const sessionRes = await app.request("/auth/session", {
      headers: { cookie: "kibitz_session=%E0%A4%A" },
    });
    expect(sessionRes.status).toBe(200);
    expect(await sessionRes.json()).toEqual({ authenticated: false, user: null });

    const invitesRes = await app.request("/invites", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "kibitz_session=%E0%A4%A",
      },
      body: JSON.stringify({ assignedRole: "student", maxUses: 1 }),
    });
    expect(invitesRes.status).toBe(401);
  });
});
