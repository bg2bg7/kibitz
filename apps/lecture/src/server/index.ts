import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { resolveAuthConfig } from "@suite/auth-core";
import { createDbClient } from "@suite/db";
import { createLectureApp } from "./app.js";
import {
  InMemoryPgnaObjectStore,
  LocalDiskPgnaObjectStore,
  S3PgnaObjectStore,
  resolveS3ConfigFromEnv,
  type PgnaObjectStore,
} from "./objectStore.js";
import {
  InMemoryStudyRepository,
  PostgresStudyRepository,
  seedDemoLecturePrimer,
  type StudyRepository,
} from "./repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const envPath of [
  path.resolve(__dirname, "../../.env"),
  path.resolve(__dirname, "../../../../.env"),
]) {
  if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
}

function bootstrapObjectStore(): PgnaObjectStore {
  const s3Config = resolveS3ConfigFromEnv(process.env);
  if (s3Config) {
    console.log(
      `[lecture] using S3 object storage (${s3Config.endpoint}/${s3Config.bucket})`,
    );
    return new S3PgnaObjectStore(s3Config);
  }

  if (process.env["NODE_ENV"] === "production") {
    throw new Error("S3_ENDPOINT / S3_BUCKET / S3 credentials are required in production.");
  }

  const localDir = process.env["LECTURE_LOCAL_STORE_DIR"]?.trim();
  if (localDir) {
    console.warn(`[lecture] S3_ENDPOINT not set; using local disk object store at ${localDir}`);
    return new LocalDiskPgnaObjectStore(localDir);
  }

  console.warn("[lecture] S3_ENDPOINT not set; using in-memory dev object store.");
  return new InMemoryPgnaObjectStore();
}

async function bootstrapRepository(objectStore: PgnaObjectStore): Promise<StudyRepository> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl) {
    const { db } = createDbClient(databaseUrl);
    console.log("[lecture] connected to PostgreSQL via DATABASE_URL");
    return new PostgresStudyRepository(db);
  }

  if (process.env["NODE_ENV"] === "production") {
    throw new Error("DATABASE_URL is required in production for apps/lecture.");
  }

  const repo = new InMemoryStudyRepository();
  await seedDemoLecturePrimer(repo, objectStore);
  console.warn(
    '[lecture] DATABASE_URL not set; running with in-memory dev store (seeded demo primer under "@demo_coach").',
  );
  return repo;
}

const port = Number(
  process.env["LECTURE_SERVER_PORT"] ?? process.env["KIBITZ_SERVER_PORT"] ?? 4002,
);
const authConfig = resolveAuthConfig(process.env);
const objectStore = bootstrapObjectStore();
const repository = await bootstrapRepository(objectStore);
const app = createLectureApp({ authConfig, repository, objectStore });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[lecture] listening on http://localhost:${info.port}`);
});
