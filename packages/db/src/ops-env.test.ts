import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "../../..");
const DRIZZLE_CONFIG_PATH = resolve(REPO_ROOT, "packages/db/drizzle.config.ts");
const TURBO_JSON_PATH = resolve(REPO_ROOT, "turbo.json");

const ALL_VITE_APPS = ["kibitz", "id", "lecture", "hall", "scribe", "arbiter", "seconds"] as const;
const SERVER_APPS = ["id", "lecture", "hall"] as const;

interface ViteConfigShape {
  envDir?: string;
  envPrefix?: string | string[];
}

interface ViteModuleShape {
  loadEnv: (mode: string, envDir: string, prefixes?: string | string[]) => Record<string, string>;
  resolveConfig: (
    inlineConfig: {
      root?: string;
      configFile?: string | false;
      envDir?: string | false;
      envPrefix?: string | string[];
      logLevel?: "info" | "warn" | "error" | "silent";
    },
    command: "build" | "serve",
    defaultMode?: string,
  ) => Promise<{ envDir?: string | false; env: Record<string, unknown> }>;
}

interface TurboConfigShape {
  globalDependencies?: string[];
  globalEnv?: string[];
  tasks?: Record<
    string,
    {
      inputs?: string[];
      env?: string[];
    }
  >;
}

function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDirAsync<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runNodeEval(
  script: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: options.cwd ?? tmpdir(),
    env: {
      PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env["HOME"] ?? tmpdir(),
      ...options.env,
    },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("OPS-01 environment & cache configuration", () => {
  it("configures all 7 Vite apps with envDir at the monorepo root and picks up VITE_* overrides via Vite", async () => {
    for (const appName of ALL_VITE_APPS) {
      const viteConfigPath = resolve(REPO_ROOT, "apps", appName, "vite.config.ts");
      const imported = (await import(pathToFileURL(viteConfigPath).href)) as {
        default: ViteConfigShape;
      };
      expect(imported.default.envDir, `apps/${appName}/vite.config.ts envDir`).toBeDefined();
      expect(resolve(imported.default.envDir!), `apps/${appName}/vite.config.ts envDir`).toBe(
        REPO_ROOT,
      );
      expect(imported.default.envPrefix, `apps/${appName}/vite.config.ts envPrefix`).toBe("VITE_");
    }

    const reqFromKibitz = createRequire(resolve(REPO_ROOT, "apps/kibitz/package.json"));
    const viteEntry = reqFromKibitz.resolve("vite");
    const vite = (await import(pathToFileURL(viteEntry).href)) as ViteModuleShape;

    await withTempDirAsync("kibitz-vite-env-", async (tempRoot) => {
      writeFileSync(
        resolve(tempRoot, ".env"),
        [
          "VITE_KIBITZ_URL=https://kibitz.override.test",
          "VITE_LECTURE_API_URL=https://api.lecture.override.test",
          "DATABASE_URL=postgresql://secret:do_not_expose@localhost:5432/secret",
          "",
        ].join("\n"),
        "utf8",
      );

      const loaded = vite.loadEnv("production", tempRoot, "VITE_");
      expect(loaded["VITE_KIBITZ_URL"]).toBe("https://kibitz.override.test");
      expect(loaded["VITE_LECTURE_API_URL"]).toBe("https://api.lecture.override.test");
      expect(loaded["DATABASE_URL"]).toBeUndefined();

      const resolved = await vite.resolveConfig(
        {
          root: resolve(REPO_ROOT, "apps/kibitz"),
          configFile: false,
          envDir: tempRoot,
          envPrefix: "VITE_",
          logLevel: "silent",
        },
        "build",
        "production",
      );
      expect(resolved.env["VITE_KIBITZ_URL"]).toBe("https://kibitz.override.test");
      expect(resolved.env["VITE_LECTURE_API_URL"]).toBe("https://api.lecture.override.test");
      expect(resolved.env["DATABASE_URL"]).toBeUndefined();
    });
  });

  it("tracks .env files and VITE_* variables in turbo.json cache inputs", () => {
    const turbo = JSON.parse(readFileSync(TURBO_JSON_PATH, "utf8")) as TurboConfigShape;

    expect(turbo.globalDependencies).toContain(".env");
    expect(turbo.globalEnv).toContain("VITE_*");
    expect(turbo.tasks?.["build"]?.inputs?.some((entry) => entry.startsWith(".env"))).toBe(true);
    expect(turbo.tasks?.["build"]?.env).toContain("VITE_*");
  });

  it("resolves a non-default DATABASE_URL in drizzle.config.ts from root .env, KIBITZ_ENV_FILE, or process.env without connecting to Postgres", () => {
    const configUrl = pathToFileURL(DRIZZLE_CONFIG_PATH).href;

    // 1. Explicit KIBITZ_ENV_FILE loaded from an arbitrary CWD without Postgres running.
    withTempDir("kibitz-drizzle-explicit-", (dir) => {
      const envFile = resolve(dir, "custom.env");
      const expectedUrl = "postgresql://custom_user:custom_pw@127.0.0.1:5499/custom_kibitz";
      writeFileSync(envFile, `DATABASE_URL=${expectedUrl}\n`, "utf8");

      const res = runNodeEval(
        `const mod = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify(mod.default.dbCredentials));`,
        { cwd: dir, env: { KIBITZ_ENV_FILE: envFile } },
      );
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout.trim())).toEqual({ url: expectedUrl });

      // 2. Explicit process.env.DATABASE_URL overrides KIBITZ_ENV_FILE.
      const overrideUrl = "postgresql://override:pw@127.0.0.1:5498/override_kibitz";
      const overrideRes = runNodeEval(
        `const mod = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify(mod.default.dbCredentials));`,
        {
          cwd: dir,
          env: { KIBITZ_ENV_FILE: envFile, DATABASE_URL: overrideUrl },
        },
      );
      expect(overrideRes.status, overrideRes.stderr).toBe(0);
      expect(JSON.parse(overrideRes.stdout.trim())).toEqual({ url: overrideUrl });
    });

    // 3. loadDrizzleEnv resolves repository-root ../../.env relative to packages/db.
    withTempDir("kibitz-drizzle-root-", (tempRepoRoot) => {
      const fakePkgDbDir = resolve(tempRepoRoot, "packages/db");
      mkdirSync(fakePkgDbDir, { recursive: true });
      const rootUrl = "postgresql://root_user:root_pw@127.0.0.1:5497/root_kibitz";
      writeFileSync(resolve(tempRepoRoot, ".env"), `DATABASE_URL=${rootUrl}\n`, "utf8");

      const res = runNodeEval(
        [
          `const mod = await import(${JSON.stringify(configUrl)});`,
          `delete process.env.DATABASE_URL;`,
          `mod.loadDrizzleEnv(${JSON.stringify(fakePkgDbDir)});`,
          `console.log(process.env.DATABASE_URL ?? "");`,
        ].join(" "),
        { cwd: tmpdir() },
      );
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe(rootUrl);
    });

    // 4. Missing explicit KIBITZ_ENV_FILE fails fast.
    withTempDir("kibitz-drizzle-missing-", (dir) => {
      const missingFile = resolve(dir, "does-not-exist.env");
      const res = runNodeEval(`await import(${JSON.stringify(configUrl)});`, {
        cwd: dir,
        env: { KIBITZ_ENV_FILE: missingFile },
      });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain("KIBITZ_ENV_FILE does not exist");
    });
  });

  it("wires upward monorepo .env discovery and KIBITZ_ENV_FILE support into all Node server entrypoints", () => {
    for (const appName of SERVER_APPS) {
      const entryPath = resolve(REPO_ROOT, "apps", appName, "src/server/index.ts");
      const src = readFileSync(entryPath, "utf8");
      expect(src, `${appName} KIBITZ_ENV_FILE`).toContain("KIBITZ_ENV_FILE");
      expect(src, `${appName} workspace root marker`).toContain("pnpm-workspace.yaml");
      expect(src, `${appName} loadRuntimeEnv`).toContain("loadRuntimeEnv(__dirname)");
    }
  });
});
