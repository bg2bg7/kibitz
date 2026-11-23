import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { hashPassword, resolveAuthConfig } from "@suite/auth-core";
import { createDbClient, runSuiteMigrations } from "@suite/db";
import { createIdApp } from "./app.js";
import {
  InMemoryIdentityRepository,
  PostgresIdentityRepository,
  type IdentityRepository,
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

async function bootstrapRepository(): Promise<IdentityRepository> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl) {
    const { db, pool } = createDbClient(databaseUrl);
    await runSuiteMigrations(pool);
    console.log("[id] connected to PostgreSQL via DATABASE_URL (migrations up to date)");
    return new PostgresIdentityRepository(db);
  }

  if (process.env["NODE_ENV"] === "production") {
    throw new Error("DATABASE_URL is required in production for apps/id.");
  }

  const repo = new InMemoryIdentityRepository();
  const devAdminHandle = process.env["INITIAL_ADMIN_HANDLE"]?.trim() ?? "";
  const devAdminPassword = process.env["INITIAL_ADMIN_PASSWORD"]?.trim() ?? "";

  if (devAdminHandle && devAdminPassword) {
    const passwordHash = await hashPassword(devAdminPassword, 8);
    repo.seedUser({
      handle: devAdminHandle,
      passwordHash,
      role: "admin",
    });
    console.warn(
      `[id] DATABASE_URL not set; running with in-memory dev store (seeded admin handle: "${devAdminHandle}").`,
    );
  } else {
    console.warn(
      "[id] DATABASE_URL not set; running with in-memory dev store without a seeded admin. Set both INITIAL_ADMIN_HANDLE and INITIAL_ADMIN_PASSWORD to opt in to seeding a dev admin.",
    );
  }
  return repo;
}

const port = Number(process.env["ID_SERVER_PORT"] ?? 4001);
const authConfig = resolveAuthConfig(process.env);
const repository = await bootstrapRepository();
const app = createIdApp({ repository, authConfig });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[id] listening on http://localhost:${info.port}`);
});
