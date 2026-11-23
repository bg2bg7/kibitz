import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { resolveAuthConfig } from "@suite/auth-core";
import { createDbClient, runSuiteMigrations } from "@suite/db";
import { createLectureApp, processPendingObjectDeletions } from "./app.js";
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

function loadRuntimeEnv(startDir: string): void {
  if (typeof process.loadEnvFile !== "function") {
    return;
  }

  const explicitEnvFile = process.env["KIBITZ_ENV_FILE"]?.trim();
  if (explicitEnvFile) {
    const resolved = path.resolve(explicitEnvFile);
    if (!existsSync(resolved)) {
      throw new Error(`KIBITZ_ENV_FILE does not exist: ${resolved}`);
    }
    process.loadEnvFile(resolved);
    return;
  }

  // Walk upward from this entrypoint (works identically from src/server/ and dist-server/,
  // independent of process.cwd()) and stop at the monorepo workspace root.
  // process.loadEnvFile preserves already-set process.env keys, so explicit runtime env vars
  // and nearer app-level .env files always take precedence.
  let currentDir = startDir;
  for (let depth = 0; depth <= 5; depth += 1) {
    const candidate = path.join(currentDir, ".env");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
    }
    if (existsSync(path.join(currentDir, "pnpm-workspace.yaml"))) {
      break;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
}

loadRuntimeEnv(__dirname);

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

async function bootstrapRepository(
  objectStore: PgnaObjectStore,
): Promise<{ repository: StudyRepository; readonlyZeroDbMode: boolean }> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl) {
    const { db, pool } = createDbClient(databaseUrl);
    await runSuiteMigrations(pool);
    console.log("[lecture] connected to PostgreSQL via DATABASE_URL (migrations up to date)");
    return { repository: new PostgresStudyRepository(db), readonlyZeroDbMode: false };
  }

  if (process.env["NODE_ENV"] === "production") {
    throw new Error("DATABASE_URL is required in production for apps/lecture.");
  }

  const repo = new InMemoryStudyRepository();
  await seedDemoLecturePrimer(repo, objectStore);
  console.warn(
    '[lecture] DATABASE_URL not set; running in read-only zero-DB dev mode (seeded demo primer under "@demo_coach"). Configure DATABASE_URL for cross-service writes.',
  );
  return { repository: repo, readonlyZeroDbMode: true };
}

const port = Number(
  process.env["LECTURE_SERVER_PORT"] ?? process.env["KIBITZ_SERVER_PORT"] ?? 4002,
);
const authConfig = resolveAuthConfig(process.env);
const objectStore = bootstrapObjectStore();
const { repository, readonlyZeroDbMode } = await bootstrapRepository(objectStore);
const app = createLectureApp({ authConfig, repository, objectStore, readonlyZeroDbMode });

if (repository.storageKind === "postgres") {
  try {
    const summary = await processPendingObjectDeletions(repository, objectStore);
    if (summary.attempted > 0) {
      console.log(
        `[lecture] startup object deletion sweep: attempted=${summary.attempted} succeeded=${summary.succeeded} failed=${summary.failed}`,
      );
    }
  } catch (err) {
    console.warn("[lecture] startup object deletion sweep failed (will retry periodically):", err);
  }

  const configuredSweepMs = Number(process.env["LECTURE_DELETION_SWEEP_INTERVAL_MS"] ?? 60_000);
  const sweepIntervalMs =
    Number.isFinite(configuredSweepMs) && configuredSweepMs >= 1_000 ? configuredSweepMs : 60_000;
  let sweepInProgress = false;
  const sweepTimer = setInterval(() => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    void processPendingObjectDeletions(repository, objectStore)
      .then((summary) => {
        if (summary.attempted > 0) {
          console.log(
            `[lecture] periodic object deletion sweep: attempted=${summary.attempted} succeeded=${summary.succeeded} failed=${summary.failed}`,
          );
        }
      })
      .catch((err) => {
        console.warn("[lecture] periodic object deletion sweep error:", err);
      })
      .finally(() => {
        sweepInProgress = false;
      });
  }, sweepIntervalMs);
  sweepTimer.unref();
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[lecture] listening on http://localhost:${info.port}`);
});
