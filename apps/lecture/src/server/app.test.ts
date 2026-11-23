import { resolveAuthConfig, signSessionToken } from "@suite/auth-core";
import { PGNA_FORMAT_VERSION, PGNA_MIME_TYPE, packPgnaArchive, unpackPgnaArchive } from "@suite/pgna";
import { describe, expect, it } from "vitest";
import { createLectureApp } from "./app.js";
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
    const app = createLectureApp({ authConfig: TEST_AUTH_CONFIG });

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
});
