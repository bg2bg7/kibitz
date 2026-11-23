import { resolveAuthConfig, signSessionToken } from "@suite/auth-core";
import { PGNA_FORMAT_VERSION, PGNA_MIME_TYPE, packPgnaArchive, unpackPgnaArchive } from "@suite/pgna";
import { describe, expect, it } from "vitest";
import {
  MAX_STUDY_DESCRIPTION_LENGTH,
  MAX_STUDY_TAGS,
  MAX_STUDY_TITLE_LENGTH,
  createLectureApp,
  processPendingObjectDeletions,
} from "./app.js";
import { InMemoryPgnaObjectStore } from "./objectStore.js";
import { InMemoryStudyRepository, seedDemoLecturePrimer } from "./repository.js";

const TEST_AUTH_CONFIG = resolveAuthConfig({
  AUTH_JWT_SECRET: "shared-cross-service-test-secret-over-32-bytes",
});

async function createSamplePgnaBytes(title = "Sicilian Najdorf Intro"): Promise<Uint8Array> {
  const packed = await packPgnaArchive({
    manifest: {
      format: "pgna",
      version: PGNA_FORMAT_VERSION,
      pgnPath: "study.pgn",
      timelinePath: "timeline.json",
      title,
      clips: {},
    },
    pgnText: `[Event "${title}"]\n[Result "*"]\n\n1. e4 { Control the center [%at #1] } 1... c5 { Sicilian [%at #2] } *`,
  });
  return packed.zipBytes;
}

describe("@suite/lecture server", () => {
  it("exposes /health and open public primers while verifying KibitzID sessions for assignments", async () => {
    const repository = new InMemoryStudyRepository();
    const studentId = "11111111-1111-4111-8111-111111111111";
    repository.registerAccount({ id: studentId, handle: "student_bob", role: "student" });
    const app = createLectureApp({ authConfig: TEST_AUTH_CONFIG, repository });

    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "lecture" });

    const primers = await app.request("/api/primers");
    expect(primers.status).toBe(200);

    const assignmentsUnauth = await app.request("/api/assignments");
    expect(assignmentsUnauth.status).toBe(401);

    const { token } = await signSessionToken(
      {
        sub: studentId,
        handle: "student_bob",
        role: "student",
        programIds: [],
      },
      TEST_AUTH_CONFIG,
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
    expect(body.viewer.role).toBe("student");
    expect(body.interactionPolicy).toBe("emoji_only");
  });

  it("publishes tagged PGNAs via KibitzID session cookie, organizes account pages by tags, and serves unauthenticated browser & viewer", async () => {
    const repository = new InMemoryStudyRepository();
    const objectStore = new InMemoryPgnaObjectStore();
    const app = createLectureApp({ authConfig: TEST_AUTH_CONFIG, repository, objectStore });

    const coachId = "22222222-2222-4222-8222-222222222222";
    const studentId = "33333333-3333-4333-8333-333333333333";
    repository.registerAccount({ id: coachId, handle: "coach_alice", role: "coach" });
    repository.registerAccount({ id: studentId, handle: "student_sam", role: "student" });

    const { token: coachToken } = await signSessionToken(
      { sub: coachId, handle: "coach_alice", role: "coach", programIds: [] },
      TEST_AUTH_CONFIG,
    );
    const { token: studentToken } = await signSessionToken(
      { sub: studentId, handle: "student_sam", role: "student", programIds: [] },
      TEST_AUTH_CONFIG,
    );
    const { token: staleToken } = await signSessionToken(
      {
        sub: "99999999-9999-4999-8999-999999999999",
        handle: "admin",
        role: "admin",
        programIds: [],
      },
      TEST_AUTH_CONFIG,
    );

    const pgnaBytes = await createSamplePgnaBytes("Sicilian Najdorf Intro");
    const makeForm = (opts: {
      bytes?: Uint8Array;
      title?: string;
      tags?: string;
      visibility?: string;
    }) => {
      const form = new FormData();
      const raw = opts.bytes ?? pgnaBytes;
      const copy = new Uint8Array(raw.byteLength);
      copy.set(raw);
      form.append("file", new Blob([copy], { type: PGNA_MIME_TYPE }), "study.pgna");
      form.append("title", opts.title ?? "Sicilian Najdorf Intro");
      form.append("description", "Sharp opening ideas for Black.");
      if (opts.tags !== undefined) form.append("tags", opts.tags);
      if (opts.visibility !== undefined) form.append("visibility", opts.visibility);
      return form;
    };

    // Unauthenticated publish -> 401
    const unauthPublish = await app.request("/api/studies", {
      method: "POST",
      body: makeForm({}),
    });
    expect(unauthPublish.status).toBe(401);

    // Orphaned/stale session UUID not in users table -> 401 + clear cookie
    const stalePublish = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${staleToken}`, origin: "http://localhost:5174" },
      body: makeForm({}),
    });
    expect(stalePublish.status).toBe(401);
    expect(stalePublish.headers.get("set-cookie")).toContain("Max-Age=0");

    // Student publish -> 403
    const studentPublish = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${studentToken}`, origin: "http://localhost:5174" },
      body: makeForm({}),
    });
    expect(studentPublish.status).toBe(403);

    // Invalid PGNA bytes -> 400
    const badZipPublish = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: makeForm({ bytes: new Uint8Array([1, 2, 3, 4]) }),
    });
    expect(badZipPublish.status).toBe(400);

    // Publish public tagged study 1
    const pub1 = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: makeForm({
        title: "Sicilian Najdorf Intro",
        tags: JSON.stringify(["Openings", "Sicilian", "openings"]),
      }),
    });
    expect(pub1.status).toBe(201);
    const pub1Json = (await pub1.json()) as {
      id: string;
      study: { id: string; tags: string[]; ownerHandle: string; moderationStatus: string };
    };
    expect(pub1Json.study.ownerHandle).toBe("coach_alice");
    expect(pub1Json.study.tags).toEqual(["openings", "sicilian"]);
    expect(pub1Json.study.moderationStatus).toBe("approved");

    // Publish public tagged study 2 (shares "openings", adds "tactics")
    const pub2 = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: makeForm({
        title: "Fried Liver Attack",
        tags: "openings, tactics",
      }),
    });
    expect(pub2.status).toBe(201);

    // Publish a private study (should NOT appear to unauthenticated callers)
    const pubPrivate = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: makeForm({
        title: "Secret Tournament Prep",
        tags: JSON.stringify(["prep"]),
        visibility: "private",
      }),
    });
    expect(pubPrivate.status).toBe(201);
    const pubPrivateJson = (await pubPrivate.json()) as { id: string };

    // Unauthenticated GET /api/studies shows only public approved studies
    const listAnon = await app.request("/api/studies");
    expect(listAnon.status).toBe(200);
    const listAnonJson = (await listAnon.json()) as {
      studies: Array<{ title: string }>;
      tags: Array<{ tag: string; count: number }>;
    };
    expect(listAnonJson.studies.map((s) => s.title).sort()).toEqual([
      "Fried Liver Attack",
      "Sicilian Najdorf Intro",
    ]);
    expect(listAnonJson.tags[0]).toEqual({ tag: "openings", count: 2 });

    // Tag filter works without login
    const byTag = await app.request("/api/studies?tag=tactics");
    const byTagJson = (await byTag.json()) as { studies: Array<{ title: string }> };
    expect(byTagJson.studies.map((s) => s.title)).toEqual(["Fried Liver Attack"]);

    // Account Lecture page organized by tags (unauthenticated!)
    const accountAnon = await app.request("/api/accounts/coach_alice/studies");
    expect(accountAnon.status).toBe(200);
    const accountAnonJson = (await accountAnon.json()) as {
      account: { handle: string; role: string };
      isOwner: boolean;
      studies: Array<{ title: string }>;
      tagGroups: Array<{ tag: string; count: number; studies: Array<{ title: string }> }>;
    };
    expect(accountAnonJson.account).toEqual({ handle: "coach_alice", role: "coach" });
    expect(accountAnonJson.isOwner).toBe(false);
    expect(accountAnonJson.studies).toHaveLength(2);
    expect(accountAnonJson.tagGroups.map((g) => [g.tag, g.count])).toEqual([
      ["openings", 2],
      ["sicilian", 1],
      ["tactics", 1],
    ]);

    // Owner viewing own account page sees private study too
    const accountOwner = await app.request("/api/accounts/coach_alice/studies", {
      headers: { cookie: `kibitz_session=${coachToken}` },
    });
    const accountOwnerJson = (await accountOwner.json()) as {
      isOwner: boolean;
      studies: Array<{ title: string }>;
    };
    expect(accountOwnerJson.isOwner).toBe(true);
    expect(accountOwnerJson.studies).toHaveLength(3);

    // Student privacy invariant: anonymous cannot view a student's /@handle page
    const studentProfileAnon = await app.request("/api/accounts/student_sam/studies");
    expect(studentProfileAnon.status).toBe(404);

    // Unauthenticated viewer can fetch public study detail + archive bytes and unpack PGNA
    const detailRes = await app.request(`/api/studies/${pub1Json.id}`);
    expect(detailRes.status).toBe(200);

    const archiveRes = await app.request(`/api/studies/${pub1Json.id}/archive`, {
      headers: { origin: "http://localhost:5172" },
    });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.headers.get("access-control-allow-origin")).toBe("http://localhost:5172");
    expect(archiveRes.headers.get("access-control-allow-credentials")).toBe("true");
    expect(archiveRes.headers.get("content-type")).toBe(PGNA_MIME_TYPE);
    const downloadedBytes = new Uint8Array(await archiveRes.arrayBuffer());
    const unpacked = await unpackPgnaArchive(downloadedBytes);
    expect(unpacked.manifest.title).toBe("Sicilian Najdorf Intro");
    expect(unpacked.timeline.entries).toHaveLength(2);

    // Anonymous cannot view private study detail or archive
    expect((await app.request(`/api/studies/${pubPrivateJson.id}`)).status).toBe(404);
    expect((await app.request(`/api/studies/${pubPrivateJson.id}/archive`)).status).toBe(404);

    // Owner can update tags via PATCH and delete via DELETE
    const patchRes = await app.request(`/api/studies/${pub1Json.id}`, {
      method: "PATCH",
      headers: {
        cookie: `kibitz_session=${coachToken}`,
        "Content-Type": "application/json",
        origin: "http://localhost:5172",
      },
      body: JSON.stringify({ tags: ["sharp-openings", "najdorf"] }),
    });
    expect(patchRes.status).toBe(200);
    const patchJson = (await patchRes.json()) as { study: { tags: string[] } };
    expect(patchJson.study.tags).toEqual(["sharp-openings", "najdorf"]);

    // Non-owner cannot delete
    const forbiddenDel = await app.request(`/api/studies/${pub1Json.id}`, {
      method: "DELETE",
      headers: { cookie: `kibitz_session=${studentToken}`, origin: "http://localhost:5172" },
    });
    expect(forbiddenDel.status).toBe(403);

    // Owner deletes study -> gone from both repo and object store
    const ownerDel = await app.request(`/api/studies/${pub1Json.id}`, {
      method: "DELETE",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5172" },
    });
    expect(ownerDel.status).toBe(200);
    expect((await app.request(`/api/studies/${pub1Json.id}`)).status).toBe(404);
  });

  it("seeds a valid playable PGNA demo primer in zero-DB dev mode", async () => {
    const repository = new InMemoryStudyRepository();
    const objectStore = new InMemoryPgnaObjectStore();
    const seeded = await seedDemoLecturePrimer(repository, objectStore);
    const app = createLectureApp({ authConfig: TEST_AUTH_CONFIG, repository, objectStore });

    const archiveRes = await app.request(`/api/studies/${seeded.id}/archive`);
    expect(archiveRes.status).toBe(200);
    const unpacked = await unpackPgnaArchive(new Uint8Array(await archiveRes.arrayBuffer()));
    expect(unpacked.manifest.title).toContain("Italian Game Essentials");
    expect(unpacked.timeline.entries.length).toBeGreaterThanOrEqual(5);
  });

  it("LEC-01: fails closed for demoted admins and deleted accounts while keeping public approved studies readable", async () => {
    const repository = new InMemoryStudyRepository();
    const objectStore = new InMemoryPgnaObjectStore();
    const app = createLectureApp({ authConfig: TEST_AUTH_CONFIG, repository, objectStore });

    const coachId = "44444444-4444-4444-8444-444444444441";
    const studentId = "44444444-4444-4444-8444-444444444442";
    const demotedAdminId = "44444444-4444-4444-8444-444444444443";
    const deletedAdminId = "44444444-4444-4444-8444-444444444444";

    repository.registerAccount({ id: coachId, handle: "coach_owner", role: "coach" });
    repository.registerAccount({ id: studentId, handle: "student_hidden", role: "student" });
    repository.registerAccount({ id: demotedAdminId, handle: "former_admin", role: "admin" });
    repository.registerAccount({ id: deletedAdminId, handle: "removed_admin", role: "admin" });

    const { token: coachToken } = await signSessionToken(
      { sub: coachId, handle: "coach_owner", role: "coach", programIds: [] },
      TEST_AUTH_CONFIG,
    );
    const { token: demotedAdminToken } = await signSessionToken(
      { sub: demotedAdminId, handle: "former_admin", role: "admin", programIds: [] },
      TEST_AUTH_CONFIG,
    );
    const { token: deletedAdminToken } = await signSessionToken(
      { sub: deletedAdminId, handle: "removed_admin", role: "admin", programIds: [] },
      TEST_AUTH_CONFIG,
    );

    const pgnaBytes = await createSamplePgnaBytes("Coach Private Study");
    const upload = async (title: string, visibility: string) => {
      const form = new FormData();
      const copy = new Uint8Array(pgnaBytes.byteLength);
      copy.set(pgnaBytes);
      form.append("file", new Blob([copy], { type: PGNA_MIME_TYPE }), "study.pgna");
      form.append("title", title);
      form.append("visibility", visibility);
      const res = await app.request("/api/studies", {
        method: "POST",
        headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
        body: form,
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string };
    };

    const publicStudy = await upload("Public Opening Primer", "public_moderated");
    const privateStudy = await upload("Private Match Prep", "private");

    // Sanity check: active admin can see private study and student profile before demotion
    expect(
      (
        await app.request(`/api/studies/${privateStudy.id}`, {
          headers: { cookie: `kibitz_session=${demotedAdminToken}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request("/api/accounts/student_hidden/studies", {
          headers: { cookie: `kibitz_session=${demotedAdminToken}` },
        })
      ).status,
    ).toBe(200);

    // Demote former_admin from admin -> student (JWT still claims role: "admin")
    repository.updateAccountRole(demotedAdminId, "student");

    const demotedList = await app.request("/api/studies", {
      headers: { cookie: `kibitz_session=${demotedAdminToken}` },
    });
    expect(demotedList.status).toBe(200);
    const demotedListJson = (await demotedList.json()) as { studies: Array<{ id: string }> };
    expect(demotedListJson.studies.map((s) => s.id)).toEqual([publicStudy.id]);

    expect(
      (
        await app.request(`/api/studies/${privateStudy.id}`, {
          headers: { cookie: `kibitz_session=${demotedAdminToken}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/studies/${privateStudy.id}/archive`, {
          headers: { cookie: `kibitz_session=${demotedAdminToken}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/api/accounts/student_hidden/studies", {
          headers: { cookie: `kibitz_session=${demotedAdminToken}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/studies/${privateStudy.id}`, {
          method: "PATCH",
          headers: {
            cookie: `kibitz_session=${demotedAdminToken}`,
            "Content-Type": "application/json",
            origin: "http://localhost:5172",
          },
          body: JSON.stringify({ title: "Hijacked" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request(`/api/studies/${privateStudy.id}`, {
          method: "DELETE",
          headers: {
            cookie: `kibitz_session=${demotedAdminToken}`,
            origin: "http://localhost:5172",
          },
        })
      ).status,
    ).toBe(403);

    // Assignments reflects live demoted DB role, not stale JWT role
    const demotedAssignments = await app.request("/api/assignments", {
      headers: { cookie: `kibitz_session=${demotedAdminToken}` },
    });
    expect(demotedAssignments.status).toBe(200);
    expect(((await demotedAssignments.json()) as { viewer: { role: string } }).viewer.role).toBe(
      "student",
    );

    // Public approved study remains readable with canEdit=false
    const demotedPublicDetail = await app.request(`/api/studies/${publicStudy.id}`, {
      headers: { cookie: `kibitz_session=${demotedAdminToken}` },
    });
    expect(demotedPublicDetail.status).toBe(200);
    expect(((await demotedPublicDetail.json()) as { canEdit: boolean }).canEdit).toBe(false);
    expect(
      (
        await app.request(`/api/studies/${publicStudy.id}/archive`, {
          headers: { cookie: `kibitz_session=${demotedAdminToken}` },
        })
      ).status,
    ).toBe(200);

    // Also verify demotion to coach (non-admin) still loses admin privileges on other users' studies
    repository.updateAccountRole(demotedAdminId, "coach");
    expect(
      (
        await app.request(`/api/studies/${privateStudy.id}`, {
          headers: { cookie: `kibitz_session=${demotedAdminToken}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/studies/${privateStudy.id}`, {
          method: "PATCH",
          headers: {
            cookie: `kibitz_session=${demotedAdminToken}`,
            "Content-Type": "application/json",
            origin: "http://localhost:5172",
          },
          body: JSON.stringify({ title: "Coach Hijack" }),
        })
      ).status,
    ).toBe(403);

    // Delete removed_admin completely (JWT still valid & signed as admin)
    expect(repository.deleteAccount(deletedAdminId)).toBe(true);

    const deletedList = await app.request("/api/studies", {
      headers: { cookie: `kibitz_session=${deletedAdminToken}` },
    });
    expect(deletedList.status).toBe(200);
    expect(deletedList.headers.get("set-cookie")).toContain("Max-Age=0");
    const deletedListJson = (await deletedList.json()) as { studies: Array<{ id: string }> };
    expect(deletedListJson.studies.map((s) => s.id)).toEqual([publicStudy.id]);

    expect(
      (
        await app.request(`/api/studies/${privateStudy.id}`, {
          headers: { cookie: `kibitz_session=${deletedAdminToken}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/studies/${privateStudy.id}/archive`, {
          headers: { cookie: `kibitz_session=${deletedAdminToken}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/api/accounts/student_hidden/studies", {
          headers: { cookie: `kibitz_session=${deletedAdminToken}` },
        })
      ).status,
    ).toBe(404);

    const deletedPatch = await app.request(`/api/studies/${privateStudy.id}`, {
      method: "PATCH",
      headers: {
        cookie: `kibitz_session=${deletedAdminToken}`,
        "Content-Type": "application/json",
        origin: "http://localhost:5172",
      },
      body: JSON.stringify({ title: "Ghost Edit" }),
    });
    expect(deletedPatch.status).toBe(401);
    expect(deletedPatch.headers.get("set-cookie")).toContain("Max-Age=0");

    const deletedDel = await app.request(`/api/studies/${privateStudy.id}`, {
      method: "DELETE",
      headers: {
        cookie: `kibitz_session=${deletedAdminToken}`,
        origin: "http://localhost:5172",
      },
    });
    expect(deletedDel.status).toBe(401);
    expect(deletedDel.headers.get("set-cookie")).toContain("Max-Age=0");

    const deletedAssignments = await app.request("/api/assignments", {
      headers: { cookie: `kibitz_session=${deletedAdminToken}` },
    });
    expect(deletedAssignments.status).toBe(401);

    // Public approved study still readable by deleted user's stale cookie (anonymous fallback)
    expect(
      (
        await app.request(`/api/studies/${publicStudy.id}`, {
          headers: { cookie: `kibitz_session=${deletedAdminToken}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/studies/${publicStudy.id}/archive`, {
          headers: { cookie: `kibitz_session=${deletedAdminToken}` },
        })
      ).status,
    ).toBe(200);
  });

  it("LEC-02: enforces program publishing authority, prevents orphaned blobs, isolates program reads, and validates PATCH transitions", async () => {
    const repository = new InMemoryStudyRepository();
    const innerStore = new InMemoryPgnaObjectStore();
    const storedKeys = new Set<string>();
    let putCalls = 0;
    const trackingObjectStore = {
      kind: innerStore.kind,
      async put(key: string, bytes: Uint8Array, contentType: string) {
        putCalls++;
        storedKeys.add(key);
        await innerStore.put(key, bytes, contentType);
      },
      async get(key: string) {
        return innerStore.get(key);
      },
      async delete(key: string) {
        storedKeys.delete(key);
        await innerStore.delete(key);
      },
    };
    const app = createLectureApp({
      authConfig: TEST_AUTH_CONFIG,
      repository,
      objectStore: trackingObjectStore,
    });

    const programAId = "aaaa1111-1111-4111-8111-111111111111";
    const programBId = "bbbb2222-2222-4222-8222-222222222222";
    const unknownProgramId = "cccc3333-3333-4333-8333-333333333333";

    repository.registerProgram({ id: programAId, name: "Academy A" });
    repository.registerProgram({ id: programBId, name: "Academy B" });

    const coachAId = "55555555-5555-4555-8555-555555555551";
    const studentAId = "55555555-5555-4555-8555-555555555552";
    const unrelatedStudentId = "55555555-5555-4555-8555-555555555553";
    const moderatorId = "55555555-5555-4555-8555-555555555554";
    const adminId = "55555555-5555-4555-8555-555555555555";

    repository.registerAccount({ id: coachAId, handle: "coach_a", role: "coach" });
    repository.registerAccount({ id: studentAId, handle: "student_a", role: "student" });
    repository.registerAccount({ id: unrelatedStudentId, handle: "student_other", role: "student" });
    repository.registerAccount({ id: moderatorId, handle: "mod_mary", role: "moderator" });
    repository.registerAccount({ id: adminId, handle: "site_admin", role: "admin" });

    repository.addProgramMembership({ programId: programAId, userId: coachAId, role: "coach" });
    repository.addProgramMembership({ programId: programAId, userId: studentAId, role: "student" });
    // Even if a moderator has a membership record, policy denies moderator program publishing
    repository.addProgramMembership({ programId: programAId, userId: moderatorId, role: "coach" });

    const sign = async (sub: string, handle: string, role: "admin" | "moderator" | "coach" | "student") =>
      (await signSessionToken({ sub, handle, role, programIds: [] }, TEST_AUTH_CONFIG)).token;

    const coachAToken = await sign(coachAId, "coach_a", "coach");
    const studentAToken = await sign(studentAId, "student_a", "student");
    const unrelatedStudentToken = await sign(unrelatedStudentId, "student_other", "student");
    const moderatorToken = await sign(moderatorId, "mod_mary", "moderator");
    const adminToken = await sign(adminId, "site_admin", "admin");

    // GET /api/programs/publishable matrix
    expect((await app.request("/api/programs/publishable")).status).toBe(401);

    const coachProgramsRes = await app.request("/api/programs/publishable", {
      headers: { cookie: `kibitz_session=${coachAToken}` },
    });
    expect(coachProgramsRes.status).toBe(200);
    expect(await coachProgramsRes.json()).toEqual({
      programs: [{ id: programAId, name: "Academy A" }],
    });

    const adminProgramsRes = await app.request("/api/programs/publishable", {
      headers: { cookie: `kibitz_session=${adminToken}` },
    });
    expect(adminProgramsRes.status).toBe(200);
    expect(await adminProgramsRes.json()).toEqual({
      programs: [
        { id: programAId, name: "Academy A" },
        { id: programBId, name: "Academy B" },
      ],
    });

    const studentProgramsRes = await app.request("/api/programs/publishable", {
      headers: { cookie: `kibitz_session=${studentAToken}` },
    });
    expect(studentProgramsRes.status).toBe(200);
    expect(await studentProgramsRes.json()).toEqual({ programs: [] });

    const moderatorProgramsRes = await app.request("/api/programs/publishable", {
      headers: { cookie: `kibitz_session=${moderatorToken}` },
    });
    expect(moderatorProgramsRes.status).toBe(200);
    expect(await moderatorProgramsRes.json()).toEqual({ programs: [] });

    const pgnaBytes = await createSamplePgnaBytes("Program Lesson");
    const buildForm = (opts: { title: string; visibility: string; programId?: string }) => {
      const form = new FormData();
      const copy = new Uint8Array(pgnaBytes.byteLength);
      copy.set(pgnaBytes);
      form.append("file", new Blob([copy], { type: PGNA_MIME_TYPE }), "study.pgna");
      form.append("title", opts.title);
      form.append("visibility", opts.visibility);
      if (opts.programId !== undefined) {
        form.append("programId", opts.programId);
      }
      return form;
    };

    // Coach A cannot publish program study without programId -> 400, no blob written
    const missingProgRes = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachAToken}`, origin: "http://localhost:5174" },
      body: buildForm({ title: "No Program", visibility: "program" }),
    });
    expect(missingProgRes.status).toBe(400);
    expect(putCalls).toBe(0);
    expect(storedKeys.size).toBe(0);

    // Coach A cannot publish to nonexistent program -> 404, no blob written
    const unknownProgRes = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachAToken}`, origin: "http://localhost:5174" },
      body: buildForm({ title: "Unknown Program", visibility: "program", programId: unknownProgramId }),
    });
    expect(unknownProgRes.status).toBe(404);
    expect(putCalls).toBe(0);
    expect(storedKeys.size).toBe(0);

    // Coach A cannot publish to Program B (unauthorized) -> 403, no blob written
    const unauthProgBRes = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachAToken}`, origin: "http://localhost:5174" },
      body: buildForm({ title: "Unauthorized B", visibility: "program", programId: programBId }),
    });
    expect(unauthProgBRes.status).toBe(403);
    expect(putCalls).toBe(0);
    expect(storedKeys.size).toBe(0);

    // Moderator cannot publish to Program A -> 403, no blob written
    const modProgARes = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${moderatorToken}`, origin: "http://localhost:5174" },
      body: buildForm({ title: "Mod Program Lesson", visibility: "program", programId: programAId }),
    });
    expect(modProgARes.status).toBe(403);
    expect(putCalls).toBe(0);
    expect(storedKeys.size).toBe(0);

    // Coach A CAN publish to Program A -> 201 with programId === programAId
    const progARes = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachAToken}`, origin: "http://localhost:5174" },
      body: buildForm({ title: "Academy A Tactics", visibility: "program", programId: programAId }),
    });
    expect(progARes.status).toBe(201);
    const progAJson = (await progARes.json()) as { id: string; study: { programId: string | null } };
    expect(progAJson.study.programId).toBe(programAId);
    expect(putCalls).toBe(1);
    expect(storedKeys.size).toBe(1);

    // Admin CAN publish to Program B -> 201 with programId === programBId
    const progBRes = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${adminToken}`, origin: "http://localhost:5174" },
      body: buildForm({ title: "Academy B Endgames", visibility: "program", programId: programBId }),
    });
    expect(progBRes.status).toBe(201);
    const progBJson = (await progBRes.json()) as { id: string; study: { programId: string | null } };
    expect(progBJson.study.programId).toBe(programBId);

    // Non-program visibility strips any supplied programId
    const privateWithStrayProg = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachAToken}`, origin: "http://localhost:5174" },
      body: buildForm({ title: "Private Draft", visibility: "private", programId: programBId }),
    });
    expect(privateWithStrayProg.status).toBe(201);
    const privateJson = (await privateWithStrayProg.json()) as {
      id: string;
      study: { programId: string | null };
    };
    expect(privateJson.study.programId).toBeNull();

    // Student in Program A CAN read Program A study & archive bytes, CANNOT read Program B
    expect(
      (
        await app.request(`/api/studies/${progAJson.id}`, {
          headers: { cookie: `kibitz_session=${studentAToken}` },
        })
      ).status,
    ).toBe(200);
    const studentAArchive = await app.request(`/api/studies/${progAJson.id}/archive`, {
      headers: { cookie: `kibitz_session=${studentAToken}` },
    });
    expect(studentAArchive.status).toBe(200);
    expect((await unpackPgnaArchive(new Uint8Array(await studentAArchive.arrayBuffer()))).manifest.title).toBe(
      "Program Lesson",
    );

    expect(
      (
        await app.request(`/api/studies/${progBJson.id}`, {
          headers: { cookie: `kibitz_session=${studentAToken}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/studies/${progBJson.id}/archive`, {
          headers: { cookie: `kibitz_session=${studentAToken}` },
        })
      ).status,
    ).toBe(404);

    // Unrelated student CANNOT read Program A study or archive
    expect(
      (
        await app.request(`/api/studies/${progAJson.id}`, {
          headers: { cookie: `kibitz_session=${unrelatedStudentToken}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/studies/${progAJson.id}/archive`, {
          headers: { cookie: `kibitz_session=${unrelatedStudentToken}` },
        })
      ).status,
    ).toBe(404);

    // PATCH private -> program enforces required & authorized programId
    const patchMissingProg = await app.request(`/api/studies/${privateJson.id}`, {
      method: "PATCH",
      headers: {
        cookie: `kibitz_session=${coachAToken}`,
        "Content-Type": "application/json",
        origin: "http://localhost:5172",
      },
      body: JSON.stringify({ visibility: "program" }),
    });
    expect(patchMissingProg.status).toBe(400);

    const patchUnauthProg = await app.request(`/api/studies/${privateJson.id}`, {
      method: "PATCH",
      headers: {
        cookie: `kibitz_session=${coachAToken}`,
        "Content-Type": "application/json",
        origin: "http://localhost:5172",
      },
      body: JSON.stringify({ visibility: "program", programId: programBId }),
    });
    expect(patchUnauthProg.status).toBe(403);

    const patchAuthProg = await app.request(`/api/studies/${privateJson.id}`, {
      method: "PATCH",
      headers: {
        cookie: `kibitz_session=${coachAToken}`,
        "Content-Type": "application/json",
        origin: "http://localhost:5172",
      },
      body: JSON.stringify({ visibility: "program", programId: programAId }),
    });
    expect(patchAuthProg.status).toBe(200);
    expect(
      ((await patchAuthProg.json()) as { study: { visibility: string; programId: string | null } })
        .study,
    ).toMatchObject({ visibility: "program", programId: programAId });
    expect(
      (
        await app.request(`/api/studies/${privateJson.id}`, {
          headers: { cookie: `kibitz_session=${studentAToken}` },
        })
      ).status,
    ).toBe(200);

    // PATCH program -> private clears programId back to null
    const patchBackToPrivate = await app.request(`/api/studies/${privateJson.id}`, {
      method: "PATCH",
      headers: {
        cookie: `kibitz_session=${coachAToken}`,
        "Content-Type": "application/json",
        origin: "http://localhost:5172",
      },
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(patchBackToPrivate.status).toBe(200);
    expect(
      (
        (await patchBackToPrivate.json()) as {
          study: { visibility: string; programId: string | null };
        }
      ).study,
    ).toMatchObject({ visibility: "private", programId: null });
    expect(
      (
        await app.request(`/api/studies/${privateJson.id}`, {
          headers: { cookie: `kibitz_session=${studentAToken}` },
        })
      ).status,
    ).toBe(404);
  });

  it("ID-05: handles malformed session cookie encoding safely and keeps valid cookies intact in readonlyZeroDbMode", async () => {
    const repository = new InMemoryStudyRepository();
    const objectStore = new InMemoryPgnaObjectStore();
    const seeded = await seedDemoLecturePrimer(repository, objectStore);

    const normalApp = createLectureApp({ authConfig: TEST_AUTH_CONFIG, repository, objectStore });
    const pgnaBytes = await createSamplePgnaBytes("Malformed Cookie Upload");
    const makeUploadForm = () => {
      const form = new FormData();
      const copy = new Uint8Array(pgnaBytes.byteLength);
      copy.set(pgnaBytes);
      form.append("file", new Blob([copy], { type: PGNA_MIME_TYPE }), "study.pgna");
      form.append("title", "Test");
      return form;
    };

    // Malformed percent-encoded cookie never throws 500
    const badCookieList = await normalApp.request("/api/studies", {
      headers: { cookie: "kibitz_session=%E0%A4%A" },
    });
    expect(badCookieList.status).toBe(200);
    const badCookieListJson = (await badCookieList.json()) as { studies: Array<{ id: string }> };
    expect(badCookieListJson.studies.map((s) => s.id)).toEqual([seeded.id]);

    const badCookiePost = await normalApp.request("/api/studies", {
      method: "POST",
      headers: { cookie: "kibitz_session=%E0%A4%A", origin: "http://localhost:5174" },
      body: makeUploadForm(),
    });
    expect(badCookiePost.status).toBe(401);

    // readonlyZeroDbMode: returns 503 on writes and never clears a valid cross-service cookie
    const zeroDbApp = createLectureApp({
      authConfig: TEST_AUTH_CONFIG,
      repository,
      objectStore,
      readonlyZeroDbMode: true,
    });

    const { token: externalIdUserToken } = await signSessionToken(
      {
        sub: "99999999-9999-4999-8999-999999999901",
        handle: "id_only_coach",
        role: "coach",
        programIds: [],
      },
      TEST_AUTH_CONFIG,
    );

    const zeroDbRead = await zeroDbApp.request("/api/studies", {
      headers: { cookie: `kibitz_session=${externalIdUserToken}` },
    });
    expect(zeroDbRead.status).toBe(200);
    expect(zeroDbRead.headers.get("set-cookie")).toBeNull();

    const zeroDbAssignments = await zeroDbApp.request("/api/assignments", {
      headers: { cookie: `kibitz_session=${externalIdUserToken}` },
    });
    expect(zeroDbAssignments.status).toBe(401);
    expect(zeroDbAssignments.headers.get("set-cookie")).toBeNull();

    const zeroDbPost = await zeroDbApp.request("/api/studies", {
      method: "POST",
      headers: {
        cookie: `kibitz_session=${externalIdUserToken}`,
        origin: "http://localhost:5174",
      },
      body: makeUploadForm(),
    });
    expect(zeroDbPost.status).toBe(503);
    expect(zeroDbPost.headers.get("set-cookie")).toBeNull();
    expect(((await zeroDbPost.json()) as { error: string }).error).toContain("DATABASE_URL");

    const zeroDbPatch = await zeroDbApp.request(`/api/studies/${seeded.id}`, {
      method: "PATCH",
      headers: {
        cookie: `kibitz_session=${externalIdUserToken}`,
        "Content-Type": "application/json",
        origin: "http://localhost:5172",
      },
      body: JSON.stringify({ title: "Blocked" }),
    });
    expect(zeroDbPatch.status).toBe(503);
    expect(zeroDbPatch.headers.get("set-cookie")).toBeNull();

    const zeroDbDelete = await zeroDbApp.request(`/api/studies/${seeded.id}`, {
      method: "DELETE",
      headers: {
        cookie: `kibitz_session=${externalIdUserToken}`,
        origin: "http://localhost:5172",
      },
    });
    expect(zeroDbDelete.status).toBe(503);
    expect(zeroDbDelete.headers.get("set-cookie")).toBeNull();
  });

  it("LEC-04: tombstones studies immediately, retains object key across restarts on transient delete failure, exposes operator metrics, and converges on retry or repeated DELETE", async () => {
    const repository = new InMemoryStudyRepository();
    const innerStore = new InMemoryPgnaObjectStore();
    let failDeletes = false;
    const flakyObjectStore = {
      kind: innerStore.kind,
      async put(key: string, bytes: Uint8Array, contentType: string) {
        await innerStore.put(key, bytes, contentType);
      },
      async get(key: string) {
        return innerStore.get(key);
      },
      async delete(key: string) {
        if (failDeletes) {
          throw new Error("S3 temporary outage (503)");
        }
        await innerStore.delete(key);
      },
    };

    const coachId = "66666666-6666-4666-8666-666666666661";
    const adminId = "66666666-6666-4666-8666-666666666662";
    const studentId = "66666666-6666-4666-8666-666666666663";
    repository.registerAccount({ id: coachId, handle: "coach_del", role: "coach" });
    repository.registerAccount({ id: adminId, handle: "admin_ops", role: "admin" });
    repository.registerAccount({ id: studentId, handle: "student_del", role: "student" });

    const { token: coachToken } = await signSessionToken(
      { sub: coachId, handle: "coach_del", role: "coach", programIds: [] },
      TEST_AUTH_CONFIG,
    );
    const { token: adminToken } = await signSessionToken(
      { sub: adminId, handle: "admin_ops", role: "admin", programIds: [] },
      TEST_AUTH_CONFIG,
    );
    const { token: studentToken } = await signSessionToken(
      { sub: studentId, handle: "student_del", role: "student", programIds: [] },
      TEST_AUTH_CONFIG,
    );

    const app = createLectureApp({
      authConfig: TEST_AUTH_CONFIG,
      repository,
      objectStore: flakyObjectStore,
    });

    const pgnaBytes = await createSamplePgnaBytes("Deletion Target");
    const uploadStudy = async (title: string) => {
      const form = new FormData();
      const copy = new Uint8Array(pgnaBytes.byteLength);
      copy.set(pgnaBytes);
      form.append("file", new Blob([copy], { type: PGNA_MIME_TYPE }), "study.pgna");
      form.append("title", title);
      form.append("visibility", "public_moderated");
      const res = await app.request("/api/studies", {
        method: "POST",
        headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
        body: form,
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { id: string };
    };

    // 1. Normal delete removes both DB visibility and object store blob immediately (200 completed)
    const normalStudy = await uploadStudy("Normal Delete Study");
    const normalRecord = await repository.getStudyById(normalStudy.id);
    expect(normalRecord).not.toBeNull();
    const normalKey = normalRecord!.pgnaObjectKey;
    expect(await innerStore.get(normalKey)).not.toBeNull();

    const normalDelRes = await app.request(`/api/studies/${normalStudy.id}`, {
      method: "DELETE",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5172" },
    });
    expect(normalDelRes.status).toBe(200);
    expect(await normalDelRes.json()).toEqual({
      deleted: true,
      id: normalStudy.id,
      cleanupStatus: "completed",
    });
    expect(await innerStore.get(normalKey)).toBeNull();
    expect(await repository.getStudyByIdIncludingDeleted(normalStudy.id)).toBeNull();

    // 2. Transient storage failure during DELETE: tombstones immediately, returns 202 pending_retry
    const retryStudy = await uploadStudy("Flaky Storage Study");
    const retryRecord = await repository.getStudyById(retryStudy.id);
    expect(retryRecord).not.toBeNull();
    const retryKey = retryRecord!.pgnaObjectKey;

    failDeletes = true;
    const flakyDelRes = await app.request(`/api/studies/${retryStudy.id}`, {
      method: "DELETE",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5172" },
    });
    expect(flakyDelRes.status).toBe(202);
    expect(await flakyDelRes.json()).toEqual({
      deleted: true,
      id: retryStudy.id,
      cleanupStatus: "pending_retry",
    });

    // Blob still exists in storage while outage continues, but study is IMMEDIATELY hidden from all reads & edits
    expect(await innerStore.get(retryKey)).not.toBeNull();
    const listAfterTombstone = (await (
      await app.request("/api/studies", {
        headers: { cookie: `kibitz_session=${coachToken}` },
      })
    ).json()) as { studies: Array<{ id: string }> };
    expect(listAfterTombstone.studies.map((s) => s.id)).not.toContain(retryStudy.id);
    expect(
      (
        await app.request(`/api/studies/${retryStudy.id}`, {
          headers: { cookie: `kibitz_session=${coachToken}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/studies/${retryStudy.id}/archive`, {
          headers: { cookie: `kibitz_session=${coachToken}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(`/api/studies/${retryStudy.id}`, {
          method: "PATCH",
          headers: {
            cookie: `kibitz_session=${coachToken}`,
            "Content-Type": "application/json",
            origin: "http://localhost:5172",
          },
          body: JSON.stringify({ title: "Should Fail" }),
        })
      ).status,
    ).toBe(404);

    // Non-admin / anonymous cannot inspect or retry admin object-deletion queue
    expect((await app.request("/api/admin/object-deletions")).status).toBe(401);
    expect(
      (
        await app.request("/api/admin/object-deletions", {
          headers: { cookie: `kibitz_session=${coachToken}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/admin/object-deletions", {
          headers: { cookie: `kibitz_session=${studentToken}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/admin/object-deletions/retry", {
          method: "POST",
          headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5172" },
        })
      ).status,
    ).toBe(403);

    // Admin sees failed counter and retained object key
    const adminQueueRes = await app.request("/api/admin/object-deletions", {
      headers: { cookie: `kibitz_session=${adminToken}` },
    });
    expect(adminQueueRes.status).toBe(200);
    const adminQueueJson = (await adminQueueRes.json()) as {
      metrics: {
        pendingCount: number;
        failedCount: number;
        completedCount: number;
        totalFailureAttempts: number;
      };
      pending: Array<{ studyId: string; pgnaObjectKey: string; status: string; attemptCount: number }>;
    };
    expect(adminQueueJson.metrics).toEqual({
      pendingCount: 0,
      failedCount: 1,
      completedCount: 1,
      totalFailureAttempts: 1,
    });
    expect(adminQueueJson.pending).toHaveLength(1);
    expect(adminQueueJson.pending[0]).toMatchObject({
      studyId: retryStudy.id,
      pgnaObjectKey: retryKey,
      status: "failed",
      attemptCount: 1,
    });

    // Simulate process restart: brand-new createLectureApp over same durable repository & object store
    const restartedApp = createLectureApp({
      authConfig: TEST_AUTH_CONFIG,
      repository,
      objectStore: flakyObjectStore,
    });

    // Before backoff elapses, a normal sweep with current time does not hammer storage
    const prematureSweep = await processPendingObjectDeletions(repository, flakyObjectStore, {
      now: new Date(),
    });
    expect(prematureSweep).toEqual({ attempted: 0, succeeded: 0, failed: 0 });

    // Storage recovers -> operator triggers admin retry on restarted app -> blob removed & study purged
    failDeletes = false;
    const adminRetryRes = await restartedApp.request("/api/admin/object-deletions/retry", {
      method: "POST",
      headers: { cookie: `kibitz_session=${adminToken}`, origin: "http://localhost:5172" },
    });
    expect(adminRetryRes.status).toBe(200);
    expect(await adminRetryRes.json()).toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      metrics: {
        pendingCount: 0,
        failedCount: 0,
        completedCount: 2,
        totalFailureAttempts: 1,
      },
    });
    expect(await innerStore.get(retryKey)).toBeNull();
    expect(await repository.getStudyByIdIncludingDeleted(retryStudy.id)).toBeNull();

    // 3. Repeated DELETE /api/studies/:id after restart converges to 200 completed once storage recovers
    const repeatStudy = await uploadStudy("Repeated Delete Convergence");
    const repeatRecord = await repository.getStudyById(repeatStudy.id);
    const repeatKey = repeatRecord!.pgnaObjectKey;

    failDeletes = true;
    const firstRepeatDel = await app.request(`/api/studies/${repeatStudy.id}`, {
      method: "DELETE",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5172" },
    });
    expect(firstRepeatDel.status).toBe(202);
    expect(await innerStore.get(repeatKey)).not.toBeNull();

    // Non-owner still cannot trigger delete on tombstoned study
    expect(
      (
        await restartedApp.request(`/api/studies/${repeatStudy.id}`, {
          method: "DELETE",
          headers: { cookie: `kibitz_session=${studentToken}`, origin: "http://localhost:5172" },
        })
      ).status,
    ).toBe(403);

    // Storage recovers -> repeated DELETE converges to 200 completed and removes blob
    failDeletes = false;
    const secondRepeatDel = await restartedApp.request(`/api/studies/${repeatStudy.id}`, {
      method: "DELETE",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5172" },
    });
    expect(secondRepeatDel.status).toBe(200);
    expect(await secondRepeatDel.json()).toEqual({
      deleted: true,
      id: repeatStudy.id,
      cleanupStatus: "completed",
    });
    expect(await innerStore.get(repeatKey)).toBeNull();
    expect(await repository.getStudyByIdIncludingDeleted(repeatStudy.id)).toBeNull();

    // 4. processPendingObjectDeletions converges once nextAttemptAt arrives
    const sweepStudy = await uploadStudy("Scheduled Sweep Convergence");
    const sweepRecord = await repository.getStudyById(sweepStudy.id);
    const sweepKey = sweepRecord!.pgnaObjectKey;

    failDeletes = true;
    expect(
      (
        await app.request(`/api/studies/${sweepStudy.id}`, {
          method: "DELETE",
          headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5172" },
        })
      ).status,
    ).toBe(202);
    expect(await innerStore.get(sweepKey)).not.toBeNull();

    failDeletes = false;
    const futureSweep = await processPendingObjectDeletions(repository, flakyObjectStore, {
      now: new Date(Date.now() + 2 * 60 * 1000),
    });
    expect(futureSweep).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
    expect(await innerStore.get(sweepKey)).toBeNull();
  });

  it("LEC-03: enforces bounded streaming upload cap, Content-Length check, per-file limit, and concurrent upload guard", async () => {
    const repository = new InMemoryStudyRepository();
    const innerStore = new InMemoryPgnaObjectStore();
    const coachId = "77777777-7777-4777-8777-777777777771";
    repository.registerAccount({ id: coachId, handle: "coach_upload", role: "coach" });
    const { token: coachToken } = await signSessionToken(
      { sub: coachId, handle: "coach_upload", role: "coach", programIds: [] },
      TEST_AUTH_CONFIG,
    );

    let putCalls = 0;
    const trackingStore = {
      kind: innerStore.kind,
      async put(key: string, bytes: Uint8Array, contentType: string) {
        putCalls++;
        await innerStore.put(key, bytes, contentType);
      },
      async get(key: string) {
        return innerStore.get(key);
      },
      async delete(key: string) {
        await innerStore.delete(key);
      },
    };

    // 1. Small maxUploadRequestBytes rejects streaming oversized body WITHOUT Content-Length before formData/storage
    const tightApp = createLectureApp({
      authConfig: TEST_AUTH_CONFIG,
      repository,
      objectStore: trackingStore,
      maxUploadBytes: 1500,
      maxUploadRequestBytes: 2048,
    });

    let chunksGenerated = 0;
    let streamCancelled = false;
    const oversizedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksGenerated >= 20) {
          controller.close();
          return;
        }
        chunksGenerated++;
        controller.enqueue(new Uint8Array(512).fill(65));
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const streamingReq = new Request("http://localhost/api/studies", {
      method: "POST",
      headers: {
        cookie: `kibitz_session=${coachToken}`,
        origin: "http://localhost:5174",
        "content-type": "multipart/form-data; boundary=----kibitz-stream-test",
      },
      body: oversizedStream,
      // @ts-expect-error Node fetch requires duplex for ReadableStream bodies
      duplex: "half",
    });
    expect(streamingReq.headers.get("content-length")).toBeNull();

    const streamingRes = await tightApp.fetch(streamingReq);
    expect(streamingRes.status).toBe(413);
    expect(streamCancelled).toBe(true);
    expect(chunksGenerated).toBeLessThan(20);
    expect(putCalls).toBe(0);

    // 2. Oversized Content-Length header rejected immediately with 413 before reading body
    let clStreamPulled = false;
    const clBody = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          clStreamPulled = true;
          controller.enqueue(new Uint8Array(100));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const clReq = new Request("http://localhost/api/studies", {
      method: "POST",
      headers: {
        cookie: `kibitz_session=${coachToken}`,
        origin: "http://localhost:5174",
        "content-type": "multipart/form-data; boundary=----kibitz-cl-test",
        "content-length": "999999",
      },
      body: clBody,
      // @ts-expect-error Node fetch requires duplex for ReadableStream bodies
      duplex: "half",
    });
    const clRes = await tightApp.fetch(clReq);
    expect(clRes.status).toBe(413);
    expect(clReq.bodyUsed).toBe(false);
    expect(clStreamPulled).toBe(false);
    expect(putCalls).toBe(0);

    // 3. Normal workbook publishes (201) under a reasonable cap, and per-file maxUploadBytes is enforced
    const pgnaBytes = await createSamplePgnaBytes("Bounded Workbook");
    const reasonableApp = createLectureApp({
      authConfig: TEST_AUTH_CONFIG,
      repository,
      objectStore: trackingStore,
      maxUploadBytes: 64 * 1024,
      maxUploadRequestBytes: 128 * 1024,
    });

    const validForm = new FormData();
    const validCopy = new Uint8Array(pgnaBytes.byteLength);
    validCopy.set(pgnaBytes);
    validForm.append("file", new Blob([validCopy], { type: PGNA_MIME_TYPE }), "study.pgna");
    validForm.append("title", "Bounded Workbook");

    const okRes = await reasonableApp.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: validForm,
    });
    expect(okRes.status).toBe(201);
    expect(putCalls).toBe(1);

    // 4. Concurrency guard: maxConcurrentUploads: 1 returns 429 + Retry-After for overlapping second upload
    let releaseFirstPut!: () => void;
    let notifyFirstPutEntered!: () => void;
    const firstPutEntered = new Promise<void>((resolve) => {
      notifyFirstPutEntered = resolve;
    });
    const firstPutGate = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    let gatedOnce = false;
    const slowStore = {
      kind: innerStore.kind,
      async put(key: string, bytes: Uint8Array, contentType: string) {
        if (!gatedOnce) {
          gatedOnce = true;
          notifyFirstPutEntered();
          await firstPutGate;
        }
        await innerStore.put(key, bytes, contentType);
      },
      async get(key: string) {
        return innerStore.get(key);
      },
      async delete(key: string) {
        await innerStore.delete(key);
      },
    };

    const singleSlotApp = createLectureApp({
      authConfig: TEST_AUTH_CONFIG,
      repository,
      objectStore: slowStore,
      maxConcurrentUploads: 1,
    });

    const makeUploadForm = (title: string) => {
      const form = new FormData();
      const copy = new Uint8Array(pgnaBytes.byteLength);
      copy.set(pgnaBytes);
      form.append("file", new Blob([copy], { type: PGNA_MIME_TYPE }), "study.pgna");
      form.append("title", title);
      return form;
    };

    const firstUploadPromise = singleSlotApp.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: makeUploadForm("First In-Flight Upload"),
    });

    await firstPutEntered;

    const secondConcurrentRes = await singleSlotApp.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: makeUploadForm("Rejected Concurrent Upload"),
    });
    expect(secondConcurrentRes.status).toBe(429);
    expect(secondConcurrentRes.headers.get("retry-after")).toBe("5");

    releaseFirstPut();
    const firstUploadRes = await firstUploadPromise;
    expect(firstUploadRes.status).toBe(201);

    // After first upload completes, semaphore is released and a new upload succeeds
    const afterReleaseRes = await singleSlotApp.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: makeUploadForm("Post-Release Upload"),
    });
    expect(afterReleaseRes.status).toBe(201);
  });

  it("SCR-05: rejects metadata overflow without silent truncation and deduplicates sequential and concurrent Idempotency-Key publishes", async () => {
    const repository = new InMemoryStudyRepository();
    const innerStore = new InMemoryPgnaObjectStore();
    const coachId = "88888888-8888-4888-8888-888888888881";
    repository.registerAccount({ id: coachId, handle: "coach_meta", role: "coach" });
    const { token: coachToken } = await signSessionToken(
      { sub: coachId, handle: "coach_meta", role: "coach", programIds: [] },
      TEST_AUTH_CONFIG,
    );

    let putCalls = 0;
    let putDelayMs = 0;
    const trackingStore = {
      kind: innerStore.kind,
      async put(key: string, bytes: Uint8Array, contentType: string) {
        if (putDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, putDelayMs));
        }
        putCalls++;
        await innerStore.put(key, bytes, contentType);
      },
      async get(key: string) {
        return innerStore.get(key);
      },
      async delete(key: string) {
        await innerStore.delete(key);
      },
    };

    const app = createLectureApp({
      authConfig: TEST_AUTH_CONFIG,
      repository,
      objectStore: trackingStore,
    });

    // CORS preflight permits Idempotency-Key
    const preflight = await app.request("/api/studies", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5174" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");

    const pgnaBytes = await createSamplePgnaBytes("Boundary Metadata Study");
    const buildForm = (opts: { title?: string; description?: string; tags?: string[] }) => {
      const form = new FormData();
      const copy = new Uint8Array(pgnaBytes.byteLength);
      copy.set(pgnaBytes);
      form.append("file", new Blob([copy], { type: PGNA_MIME_TYPE }), "study.pgna");
      form.append("title", opts.title ?? "Valid Title");
      form.append("description", opts.description ?? "Valid Description");
      if (opts.tags !== undefined) {
        form.append("tags", JSON.stringify(opts.tags));
      }
      return form;
    };

    const twelveTags = Array.from({ length: MAX_STUDY_TAGS }, (_, i) => `tag-${i + 1}`);
    const thirteenTags = [...twelveTags, "tag-overflow"];

    // 1. Over-limit title (201), description (4001), and tags (13) are rejected with 400 and NO blob is written
    const overTitleRes = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: buildForm({ title: "T".repeat(MAX_STUDY_TITLE_LENGTH + 1) }),
    });
    expect(overTitleRes.status).toBe(400);
    expect(putCalls).toBe(0);

    const overDescRes = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: buildForm({ description: "D".repeat(MAX_STUDY_DESCRIPTION_LENGTH + 1) }),
    });
    expect(overDescRes.status).toBe(400);
    expect(putCalls).toBe(0);

    const overTagsRes = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: buildForm({ tags: thirteenTags }),
    });
    expect(overTagsRes.status).toBe(400);
    expect(putCalls).toBe(0);

    // Invalid Idempotency-Key rejected with 400
    const badKeyRes = await app.request("/api/studies", {
      method: "POST",
      headers: {
        cookie: `kibitz_session=${coachToken}`,
        origin: "http://localhost:5174",
        "Idempotency-Key": "invalid key with spaces!",
      },
      body: buildForm({}),
    });
    expect(badKeyRes.status).toBe(400);
    expect(putCalls).toBe(0);

    // 2. Exact boundary lengths (title=200, description=4000, 12 tags) succeed and round-trip unchanged
    const exactTitle = "A".repeat(MAX_STUDY_TITLE_LENGTH);
    const exactDescription = "B".repeat(MAX_STUDY_DESCRIPTION_LENGTH);
    const boundaryRes = await app.request("/api/studies", {
      method: "POST",
      headers: { cookie: `kibitz_session=${coachToken}`, origin: "http://localhost:5174" },
      body: buildForm({ title: exactTitle, description: exactDescription, tags: twelveTags }),
    });
    expect(boundaryRes.status).toBe(201);
    const boundaryJson = (await boundaryRes.json()) as {
      id: string;
      study: { title: string; description: string; tags: string[] };
    };
    expect(boundaryJson.study.title).toBe(exactTitle);
    expect(boundaryJson.study.description).toBe(exactDescription);
    expect(boundaryJson.study.tags).toEqual(twelveTags);
    expect(putCalls).toBe(1);

    const fetchedBoundary = (await (
      await app.request(`/api/studies/${boundaryJson.id}`)
    ).json()) as { study: { title: string; description: string; tags: string[] } };
    expect(fetchedBoundary.study.title).toBe(exactTitle);
    expect(fetchedBoundary.study.description).toBe(exactDescription);
    expect(fetchedBoundary.study.tags).toEqual(twelveTags);

    // PATCH also rejects 13 unique tags instead of silently dropping overflow
    const patchOverTagsRes = await app.request(`/api/studies/${boundaryJson.id}`, {
      method: "PATCH",
      headers: {
        cookie: `kibitz_session=${coachToken}`,
        "Content-Type": "application/json",
        origin: "http://localhost:5172",
      },
      body: JSON.stringify({ tags: thirteenTags }),
    });
    expect(patchOverTagsRes.status).toBe(400);

    // 3. Sequential Idempotency-Key replay produces exactly ONE study and ONE blob
    const seqKey = "scribe-publish-seq-001";
    const seqFirstRes = await app.request("/api/studies", {
      method: "POST",
      headers: {
        cookie: `kibitz_session=${coachToken}`,
        origin: "http://localhost:5174",
        "Idempotency-Key": seqKey,
      },
      body: buildForm({ title: "Idempotent Sequential Study" }),
    });
    expect(seqFirstRes.status).toBe(201);
    const seqFirstJson = (await seqFirstRes.json()) as { id: string; studyId: string };
    expect(putCalls).toBe(2);

    const seqReplayRes = await app.request("/api/studies", {
      method: "POST",
      headers: {
        cookie: `kibitz_session=${coachToken}`,
        origin: "http://localhost:5174",
        "Idempotency-Key": seqKey,
      },
      body: buildForm({ title: "Idempotent Sequential Study" }),
    });
    expect(seqReplayRes.status).toBe(200);
    const seqReplayJson = (await seqReplayRes.json()) as {
      id: string;
      studyId: string;
      idempotentReplay: boolean;
    };
    expect(seqReplayJson.id).toBe(seqFirstJson.id);
    expect(seqReplayJson.studyId).toBe(seqFirstJson.id);
    expect(seqReplayJson.idempotentReplay).toBe(true);
    expect(putCalls).toBe(2);

    // 4. Concurrent duplicate POSTs with the same Idempotency-Key coalesce to ONE study and ONE blob
    putDelayMs = 40;
    const concKey = "scribe-publish-concurrent-001";
    const [concA, concB] = await Promise.all([
      app.request("/api/studies", {
        method: "POST",
        headers: {
          cookie: `kibitz_session=${coachToken}`,
          origin: "http://localhost:5174",
          "Idempotency-Key": concKey,
        },
        body: buildForm({ title: "Idempotent Concurrent Study" }),
      }),
      app.request("/api/studies", {
        method: "POST",
        headers: {
          cookie: `kibitz_session=${coachToken}`,
          origin: "http://localhost:5174",
          "Idempotency-Key": concKey,
        },
        body: buildForm({ title: "Idempotent Concurrent Study" }),
      }),
    ]);

    const statuses = [concA.status, concB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 201]);
    const concAJson = (await concA.json()) as { id: string; idempotentReplay?: boolean };
    const concBJson = (await concB.json()) as { id: string; idempotentReplay?: boolean };
    expect(concAJson.id).toBe(concBJson.id);
    expect([concAJson.idempotentReplay, concBJson.idempotentReplay]).toContain(true);
    expect(putCalls).toBe(3);

    const allStudies = await repository.listAllStudies();
    expect(allStudies).toHaveLength(3);
  });

  it("LEC-05: normalizes displayed @handle queries in free-text ?q= search while enforcing visibility", async () => {
    const repository = new InMemoryStudyRepository();
    const objectStore = new InMemoryPgnaObjectStore();
    const app = createLectureApp({ authConfig: TEST_AUTH_CONFIG, repository, objectStore });

    const coachId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
    const otherCoachId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";
    repository.registerAccount({ id: coachId, handle: "Coach_Alice", role: "coach" });
    repository.registerAccount({ id: otherCoachId, handle: "coach_bob", role: "coach" });

    const { token: coachToken } = await signSessionToken(
      { sub: coachId, handle: "Coach_Alice", role: "coach", programIds: [] },
      TEST_AUTH_CONFIG,
    );

    await repository.createStudy({
      id: "11111111-2222-4333-8444-555555555501",
      ownerUserId: coachId,
      ownerHandle: "Coach_Alice",
      ownerRole: "coach",
      title: "Rook Endgames Fundamentals",
      description: "Lucena and Philidor positions.",
      tags: ["endgames"],
      pgnaObjectKey: "studies/coach/s1.pgna",
      visibility: "public_moderated",
      moderationStatus: "approved",
    });
    await repository.createStudy({
      id: "11111111-2222-4333-8444-555555555502",
      ownerUserId: coachId,
      ownerHandle: "Coach_Alice",
      ownerRole: "coach",
      title: "Private Preparation Notes",
      description: "Top secret opening repertoire.",
      tags: ["prep"],
      pgnaObjectKey: "studies/coach/s2.pgna",
      visibility: "private",
      moderationStatus: "pending",
    });
    await repository.createStudy({
      id: "11111111-2222-4333-8444-555555555503",
      ownerUserId: otherCoachId,
      ownerHandle: "coach_bob",
      ownerRole: "coach",
      title: "King and Pawn Basics",
      description: "Opposition and key squares.",
      tags: ["endgames"],
      pgnaObjectKey: "studies/bob/s3.pgna",
      visibility: "public_moderated",
      moderationStatus: "approved",
    });

    // Anonymous search for @coach_alice (with no matching title) returns ONLY Coach_Alice's public study
    const anonRes = await app.request("/api/studies?q=%40coach_alice");
    expect(anonRes.status).toBe(200);
    const anonJson = (await anonRes.json()) as { studies: Array<{ title: string }> };
    expect(anonJson.studies.map((s) => s.title)).toEqual(["Rook Endgames Fundamentals"]);

    // Authenticated owner search for @Coach_Alice returns both public and private studies owned by Coach_Alice
    const ownerRes = await app.request("/api/studies?q=%40Coach_Alice", {
      headers: { cookie: `kibitz_session=${coachToken}` },
    });
    expect(ownerRes.status).toBe(200);
    const ownerJson = (await ownerRes.json()) as { studies: Array<{ title: string }> };
    expect(ownerJson.studies.map((s) => s.title).sort()).toEqual([
      "Private Preparation Notes",
      "Rook Endgames Fundamentals",
    ]);
  });
});

