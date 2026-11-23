import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { hashPassword, resolveAuthConfig } from "@suite/auth-core";
import { createDbClient } from "@suite/db";
import { createIdApp } from "./app.js";
import {
  InMemoryIdentityRepository,
  PostgresIdentityRepository,
  type IdentityRepository,
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

async function bootstrapRepository(): Promise<IdentityRepository> {
  const databaseUrl = process.env["DATABASE_URL"]?.trim();
  if (databaseUrl) {
    const { db } = createDbClient(databaseUrl);
    console.log("[id] connected to PostgreSQL via DATABASE_URL");
    return new PostgresIdentityRepository(db);
  }

  if (process.env["NODE_ENV"] === "production") {
    throw new Error("DATABASE_URL is required in production for apps/id.");
  }

  const repo = new InMemoryIdentityRepository();
  const devAdminHandle = process.env["INITIAL_ADMIN_HANDLE"]?.trim() || "admin";
  const devAdminPassword =
    process.env["INITIAL_ADMIN_PASSWORD"]?.trim() || "kibitz_dev_admin_password";
  const passwordHash = await hashPassword(devAdminPassword, 8);
  repo.seedUser({
    handle: devAdminHandle,
    passwordHash,
    role: "admin",
  });
  console.warn(
    `[id] DATABASE_URL not set; running with in-memory dev store (seeded admin handle: "${devAdminHandle}").`,
  );
  return repo;
}

const port = Number(process.env["ID_SERVER_PORT"] ?? 4001);
const authConfig = resolveAuthConfig(process.env);
const repository = await bootstrapRepository();
const app = createIdApp({ repository, authConfig });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[id] listening on http://localhost:${info.port}`);
});
