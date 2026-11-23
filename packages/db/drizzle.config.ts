import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

const DEFAULT_DEV_DATABASE_URL =
  "postgresql://kibitz:kibitz_dev_password@localhost:5432/kibitz_suite";

const configDir =
  typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

/**
 * Loads environment variables for Drizzle CLI invocations from `packages/db`.
 * Precedence:
 *   1. Explicit process.env keys already set by the caller.
 *   2. Explicit `KIBITZ_ENV_FILE` (if set; fails fast if the file does not exist).
 *   3. Workspace-local `packages/db/.env`, then repository root `.env`.
 */
export function loadDrizzleEnv(baseDir: string = configDir): void {
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

  for (const candidate of [path.resolve(baseDir, ".env"), path.resolve(baseDir, "../../.env")]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
    }
  }
}

loadDrizzleEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env["DATABASE_URL"]?.trim() || DEFAULT_DEV_DATABASE_URL,
  },
});
