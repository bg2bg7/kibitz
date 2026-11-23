import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "../../..");
const COMPOSE_FILE = resolve(REPO_ROOT, "docker-compose.yml");
const ENV_EXAMPLE_FILE = resolve(REPO_ROOT, ".env.example");
const INIT_SCRIPT = resolve(REPO_ROOT, "docker/postgres/init-db-and-admin.sh");
const DRIZZLE_DIR = resolve(REPO_ROOT, "packages/db/drizzle");
const JOURNAL_FILE = resolve(DRIZZLE_DIR, "meta/_journal.json");

const EXPECTED_POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:f2f98726820d0342055351c6e9d36e705f5bfffb3dd53ff556325114b08afb6d";
const EXPECTED_RUSTFS_IMAGE =
  "rustfs/rustfs@sha256:ee717072290bec9b11abfc0365f8310b00df1cd9b3639943edae47bdef05044a";

interface ComposePort {
  host_ip?: string;
  target: number;
  published: string;
  protocol?: string;
}

interface ComposeService {
  image: string;
  environment?: Record<string, string | null>;
  ports?: ComposePort[];
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
}

function sanitizedBaseEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env["HOME"] ?? tmpdir(),
  };
}

function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(resolve(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runComposeConfig(envFileContent: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  return withTempDir("kibitz-compose-test-", (dir) => {
    const envFile = resolve(dir, "test.env");
    writeFileSync(envFile, envFileContent, "utf8");
    const result = spawnSync(
      "docker",
      ["compose", "--env-file", envFile, "-f", COMPOSE_FILE, "config", "--format", "json"],
      {
        cwd: REPO_ROOT,
        env: sanitizedBaseEnv(),
        encoding: "utf8",
      },
    );
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  });
}

function parseComposeConfig(envFileContent: string): ComposeConfig {
  const result = runComposeConfig(envFileContent);
  expect(result.status, `docker compose config failed: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as ComposeConfig;
}

function runInitScriptWithStubbedPsql(extraEnv: Record<string, string | undefined>): {
  status: number | null;
  stdout: string;
  stderr: string;
  psqlLog: string;
} {
  return withTempDir("kibitz-init-test-", (dir) => {
    const binDir = resolve(dir, "bin");
    const psqlPath = resolve(binDir, "psql");
    const logPath = resolve(dir, "psql.log");

    // Create a minimal stub psql that logs its arguments and stdin SQL without touching any DB.
    spawnSync("mkdir", ["-p", binDir], { encoding: "utf8" });
    writeFileSync(
      psqlPath,
      [
        "#!/bin/sh",
        `{ printf '=== PSQL ARGS: %s\\n' "$*"; cat; printf '\\n=== END PSQL ===\\n'; } >> "${logPath}"`,
        "exit 0",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(psqlPath, 0o755);

    const env: NodeJS.ProcessEnv = {
      ...sanitizedBaseEnv(),
      PATH: `${binDir}:${sanitizedBaseEnv()["PATH"] ?? "/usr/bin:/bin"}`,
      POSTGRES_USER: "kibitz",
      POSTGRES_DB: "kibitz_suite",
    };

    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }

    const result = spawnSync("sh", [INIT_SCRIPT], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });

    let psqlLog = "";
    try {
      psqlLog = readFileSync(logPath, "utf8");
    } catch {
      psqlLog = "";
    }

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      psqlLog,
    };
  });
}

const VALID_MINIMAL_ENV = [
  "POSTGRES_PASSWORD=generated_pg_password_for_test",
  "S3_ACCESS_KEY_ID=generated_s3_access_key",
  "S3_SECRET_ACCESS_KEY=generated_s3_secret_key",
  "",
].join("\n");

describe("OPS-03 containment: docker-compose.yml", () => {
  it("binds all published ports to 127.0.0.1 by default and honors explicit bind-host overrides", () => {
    const config = parseComposeConfig(VALID_MINIMAL_ENV);
    const allPorts = Object.values(config.services).flatMap((service) => service.ports ?? []);

    expect(allPorts.length).toBe(3);
    for (const port of allPorts) {
      expect(port.host_ip).toBe("127.0.0.1");
      expect(port.host_ip).not.toBe("0.0.0.0");
      expect(port.host_ip).not.toBe("::");
    }

    expect(config.services["postgres"]?.ports).toEqual([
      expect.objectContaining({ host_ip: "127.0.0.1", target: 5432, published: "5432" }),
    ]);
    expect(config.services["s3"]?.ports).toEqual([
      expect.objectContaining({ host_ip: "127.0.0.1", target: 9000, published: "9000" }),
      expect.objectContaining({ host_ip: "127.0.0.1", target: 9001, published: "9001" }),
    ]);

    const overridden = parseComposeConfig(
      [
        VALID_MINIMAL_ENV,
        "POSTGRES_BIND_HOST=127.0.0.2",
        "S3_BIND_HOST=127.0.0.3",
        "S3_CONSOLE_BIND_HOST=127.0.0.4",
      ].join("\n"),
    );
    expect(overridden.services["postgres"]?.ports?.[0]?.host_ip).toBe("127.0.0.2");
    expect(overridden.services["s3"]?.ports?.[0]?.host_ip).toBe("127.0.0.3");
    expect(overridden.services["s3"]?.ports?.[1]?.host_ip).toBe("127.0.0.4");
  });

  it("pins postgres, s3, and s3-init to reviewed @sha256 digests with identical RustFS digests", () => {
    const config = parseComposeConfig(VALID_MINIMAL_ENV);
    const postgresImage = config.services["postgres"]?.image;
    const s3Image = config.services["s3"]?.image;
    const s3InitImage = config.services["s3-init"]?.image;

    expect(postgresImage).toBe(EXPECTED_POSTGRES_IMAGE);
    expect(s3Image).toBe(EXPECTED_RUSTFS_IMAGE);
    expect(s3InitImage).toBe(EXPECTED_RUSTFS_IMAGE);
    expect(s3Image).toBe(s3InitImage);

    for (const image of [postgresImage, s3Image, s3InitImage]) {
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
      expect(image).not.toContain(":latest");
    }
  });

  it("resolves absent and empty INITIAL_ADMIN_* values to empty strings instead of default credentials", () => {
    const absent = parseComposeConfig(VALID_MINIMAL_ENV);
    expect(absent.services["postgres"]?.environment?.["INITIAL_ADMIN_HANDLE"]).toBe("");
    expect(absent.services["postgres"]?.environment?.["INITIAL_ADMIN_PASSWORD"]).toBe("");

    const empty = parseComposeConfig(
      [VALID_MINIMAL_ENV, "INITIAL_ADMIN_HANDLE=", "INITIAL_ADMIN_PASSWORD="].join("\n"),
    );
    expect(empty.services["postgres"]?.environment?.["INITIAL_ADMIN_HANDLE"]).toBe("");
    expect(empty.services["postgres"]?.environment?.["INITIAL_ADMIN_PASSWORD"]).toBe("");

    const explicit = parseComposeConfig(
      [
        VALID_MINIMAL_ENV,
        "INITIAL_ADMIN_HANDLE=bootstrap_admin",
        "INITIAL_ADMIN_PASSWORD=explicit_generated_pass",
      ].join("\n"),
    );
    expect(explicit.services["postgres"]?.environment?.["INITIAL_ADMIN_HANDLE"]).toBe(
      "bootstrap_admin",
    );
    expect(explicit.services["postgres"]?.environment?.["INITIAL_ADMIN_PASSWORD"]).toBe(
      "explicit_generated_pass",
    );
  });

  it("fails Compose config resolution when privileged credentials are missing or empty", () => {
    const missingPgPass = runComposeConfig(
      ["S3_ACCESS_KEY_ID=key", "S3_SECRET_ACCESS_KEY=secret"].join("\n"),
    );
    expect(missingPgPass.status).not.toBe(0);
    expect(missingPgPass.stderr).toContain("POSTGRES_PASSWORD");

    const missingS3Key = runComposeConfig(
      ["POSTGRES_PASSWORD=pgpass", "S3_SECRET_ACCESS_KEY=secret"].join("\n"),
    );
    expect(missingS3Key.status).not.toBe(0);
    expect(missingS3Key.stderr).toContain("S3_ACCESS_KEY_ID");

    const missingS3Secret = runComposeConfig(
      ["POSTGRES_PASSWORD=pgpass", "S3_ACCESS_KEY_ID=key"].join("\n"),
    );
    expect(missingS3Secret.status).not.toBe(0);
    expect(missingS3Secret.stderr).toContain("S3_SECRET_ACCESS_KEY");

    const rawExample = spawnSync(
      "docker",
      ["compose", "--env-file", ENV_EXAMPLE_FILE, "-f", COMPOSE_FILE, "config", "--quiet"],
      {
        cwd: REPO_ROOT,
        env: sanitizedBaseEnv(),
        encoding: "utf8",
      },
    );
    expect(rawExample.status).not.toBe(0);
  });
});

describe("OPS-03 containment: .env.example", () => {
  it("leaves privileged credentials blank and contains no legacy default secrets", () => {
    const content = readFileSync(ENV_EXAMPLE_FILE, "utf8");

    expect(content).toMatch(/^POSTGRES_PASSWORD=$/m);
    expect(content).toMatch(/^INITIAL_ADMIN_HANDLE=$/m);
    expect(content).toMatch(/^INITIAL_ADMIN_PASSWORD=$/m);
    expect(content).toMatch(/^S3_ACCESS_KEY_ID=$/m);
    expect(content).toMatch(/^S3_SECRET_ACCESS_KEY=$/m);
    expect(content).toMatch(/^AUTH_JWT_SECRET=$/m);

    for (const forbidden of [
      "kibitz_dev_password",
      "kibitz_dev_admin_password",
      "kibitz_s3_admin",
      "kibitz_s3_dev_secret",
      "dev-only-replace-me-with-at-least-32-random-bytes",
    ]) {
      expect(content).not.toContain(forbidden);
    }
  });
});

describe("OPS-03 containment: docker/postgres/init-db-and-admin.sh", () => {
  it("passes POSIX shell syntax validation (`sh -n`)", () => {
    const check = spawnSync("sh", ["-n", INIT_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(check.status, check.stderr).toBe(0);
  });

  it("skips admin INSERT and exits 0 when INITIAL_ADMIN_PASSWORD is unset, empty, or whitespace", () => {
    const cases: Array<Record<string, string | undefined>> = [
      { INITIAL_ADMIN_HANDLE: "admin", INITIAL_ADMIN_PASSWORD: undefined },
      { INITIAL_ADMIN_HANDLE: "admin", INITIAL_ADMIN_PASSWORD: "" },
      { INITIAL_ADMIN_HANDLE: "admin", INITIAL_ADMIN_PASSWORD: "   \t  " },
      { INITIAL_ADMIN_HANDLE: "   \t ", INITIAL_ADMIN_PASSWORD: "valid-secret-123" },
      { INITIAL_ADMIN_HANDLE: undefined, INITIAL_ADMIN_PASSWORD: undefined },
    ];

    for (const envCase of cases) {
      const result = runInitScriptWithStubbedPsql(envCase);
      expect(result.status, result.stderr).toBe(0);
      expect(result.psqlLog).not.toContain('INSERT INTO "users"');
      expect(result.stdout).toContain("skipping initial admin seed");
    }
  });

  it("runs admin INSERT when INITIAL_ADMIN_HANDLE and INITIAL_ADMIN_PASSWORD are explicitly set (<= 72 UTF-8 bytes)", () => {
    const exact72Ascii = "a".repeat(72);
    const result = runInitScriptWithStubbedPsql({
      INITIAL_ADMIN_HANDLE: "  club_admin  ",
      INITIAL_ADMIN_PASSWORD: exact72Ascii,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.psqlLog).toContain('INSERT INTO "users"');
    expect(result.psqlLog).toContain("admin_handle=club_admin");
    expect(result.psqlLog).toContain(`admin_password=${exact72Ascii}`);
  });

  it("fails fast without running admin INSERT when INITIAL_ADMIN_PASSWORD exceeds 72 UTF-8 bytes", () => {
    const overAscii = "a".repeat(73);
    const asciiResult = runInitScriptWithStubbedPsql({
      INITIAL_ADMIN_HANDLE: "admin",
      INITIAL_ADMIN_PASSWORD: overAscii,
    });

    expect(asciiResult.status).not.toBe(0);
    expect(asciiResult.stderr).toContain("72-byte UTF-8 limit");
    expect(asciiResult.stderr).not.toContain(overAscii);
    expect(asciiResult.psqlLog).not.toContain('INSERT INTO "users"');

    // 25 chess pawn characters = 25 code points, 75 UTF-8 bytes (> 72).
    const overMultibyte = "♟".repeat(25);
    expect(Buffer.byteLength(overMultibyte, "utf8")).toBe(75);
    const multibyteResult = runInitScriptWithStubbedPsql({
      INITIAL_ADMIN_HANDLE: "admin",
      INITIAL_ADMIN_PASSWORD: overMultibyte,
    });

    expect(multibyteResult.status).not.toBe(0);
    expect(multibyteResult.stderr).toContain("72-byte UTF-8 limit");
    expect(multibyteResult.stderr).toContain("75 bytes");
    expect(multibyteResult.psqlLog).not.toContain('INSERT INTO "users"');
  });
});

interface DrizzleJournal {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
}

interface SimulatedPsqlInvocation {
  args: string[];
  rawSql: string;
  executedSql: string;
  skipped: boolean;
  vars: Record<string, string>;
}

interface SimulatedPsqlState {
  appliedHashes: string[];
  invocations: SimulatedPsqlInvocation[];
}

function createStatefulStubPsql(binDir: string, statePath: string): void {
  const stubScriptPath = resolve(binDir, "psql-sim.mjs");
  const psqlWrapperPath = resolve(binDir, "psql");

  // Simulates psql -v var=value, \gset already_applied check, and \if :already_applied / \else / \endif
  // inside BEGIN ... COMMIT transactions against a persisted JSON state file.
  const simScript = `
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.argv[2];
const psqlArgs = process.argv.slice(3);
const rawSql = readFileSync(0, "utf8");

const vars = {};
for (let i = 0; i < psqlArgs.length; i++) {
  if (psqlArgs[i] === "-v" && i + 1 < psqlArgs.length) {
    const pair = psqlArgs[++i];
    const eq = pair.indexOf("=");
    if (eq !== -1) {
      vars[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
}

const state = JSON.parse(readFileSync(statePath, "utf8"));
const appliedSet = new Set(state.appliedHashes);

const lines = rawSql.split(/\\r?\\n/);
let alreadyApplied = false;
let inIf = false;
let inElse = false;
let skipped = false;
const executedLines = [];

for (const line of lines) {
  const trimmed = line.trim();
  if (trimmed.includes("AS already_applied \\\\gset")) {
    alreadyApplied = vars.migration_hash ? appliedSet.has(vars.migration_hash) : false;
    executedLines.push(line);
    continue;
  }
  if (trimmed === "\\\\if :already_applied") {
    inIf = true;
    inElse = false;
    if (alreadyApplied) {
      skipped = true;
    }
    continue;
  }
  if (trimmed === "\\\\else") {
    inElse = true;
    continue;
  }
  if (trimmed === "\\\\endif") {
    inIf = false;
    inElse = false;
    continue;
  }

  const branchActive = !inIf || (inElse ? !alreadyApplied : alreadyApplied);
  if (!branchActive) {
    continue;
  }

  if (trimmed.startsWith("\\\\echo ")) {
    const msg = trimmed.slice(6).replace(/:([a-zA-Z0-9_]+)/g, (_, name) => vars[name] ?? ":" + name);
    process.stdout.write(msg + "\\n");
    continue;
  }

  executedLines.push(line);
}

const executedSql = executedLines.join("\\n");
const committed =
  executedSql.includes("BEGIN;") &&
  executedSql.includes("COMMIT;") &&
  executedSql.includes('INSERT INTO "drizzle"."__drizzle_migrations"');

if (committed && vars.migration_hash && !appliedSet.has(vars.migration_hash)) {
  state.appliedHashes.push(vars.migration_hash);
}

state.invocations.push({
  args: psqlArgs,
  rawSql,
  executedSql,
  skipped,
  vars,
});

writeFileSync(statePath, JSON.stringify(state), "utf8");
`;

  writeFileSync(stubScriptPath, simScript, "utf8");
  writeFileSync(
    psqlWrapperPath,
    `#!/bin/sh\nexec "${process.execPath}" "${stubScriptPath}" "${statePath}" "$@"\n`,
    "utf8",
  );
  chmodSync(psqlWrapperPath, 0o755);
}

function readDrizzleJournal(): DrizzleJournal {
  return JSON.parse(readFileSync(JOURNAL_FILE, "utf8")) as DrizzleJournal;
}

describe("OPS-04 transactional, locked, resumable migrations", () => {
  it("keeps packages/db/drizzle/meta/_journal.json in sync with existing SQL files including 0002", () => {
    const journal = readDrizzleJournal();
    expect(journal.entries.length).toBeGreaterThanOrEqual(3);
    expect(journal.entries.some((entry) => entry.tag.startsWith("0002_"))).toBe(true);

    for (const [idx, entry] of journal.entries.entries()) {
      expect(entry.idx).toBe(idx);
      const sqlPath = resolve(DRIZZLE_DIR, `${entry.tag}.sql`);
      expect(existsSync(sqlPath), `Missing migration SQL file: ${sqlPath}`).toBe(true);
      const sqlContent = readFileSync(sqlPath, "utf8").trim();
      expect(sqlContent.length).toBeGreaterThan(0);
    }
  });

  it("applies each migration DDL and drizzle.__drizzle_migrations insert in ONE advisory-locked transaction", () => {
    const journal = readDrizzleJournal();

    withTempDir("kibitz-ops04-atomic-", (dir) => {
      const binDir = resolve(dir, "bin");
      const statePath = resolve(dir, "state.json");
      spawnSync("mkdir", ["-p", binDir], { encoding: "utf8" });
      const initialState: SimulatedPsqlState = { appliedHashes: [], invocations: [] };
      writeFileSync(statePath, JSON.stringify(initialState), "utf8");
      createStatefulStubPsql(binDir, statePath);

      const env: NodeJS.ProcessEnv = {
        ...sanitizedBaseEnv(),
        PATH: `${binDir}:${sanitizedBaseEnv()["PATH"] ?? "/usr/bin:/bin"}`,
        POSTGRES_USER: "kibitz",
        POSTGRES_DB: "kibitz_suite",
        MIGRATIONS_DIR: DRIZZLE_DIR,
      };

      const result = spawnSync("sh", [INIT_SCRIPT], {
        cwd: REPO_ROOT,
        env,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);

      const state = JSON.parse(readFileSync(statePath, "utf8")) as SimulatedPsqlState;
      // 1 bootstrap invocation for drizzle.__drizzle_migrations + exactly 1 invocation per journal entry
      // (never 2 separate psql calls for DDL and journal INSERT).
      expect(state.invocations.length).toBe(1 + journal.entries.length);

      const bootstrap = state.invocations[0];
      expect(bootstrap?.rawSql).toContain("BEGIN;");
      expect(bootstrap?.rawSql).toContain("SELECT pg_advisory_xact_lock(42190837);");
      expect(bootstrap?.rawSql).toContain('CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations"');
      expect(bootstrap?.rawSql).toContain("COMMIT;");

      for (const [index, entry] of journal.entries.entries()) {
        const invocation = state.invocations[1 + index];
        expect(invocation).toBeDefined();
        if (!invocation) continue;

        const sqlPath = resolve(DRIZZLE_DIR, `${entry.tag}.sql`);
        const expectedSql = readFileSync(sqlPath, "utf8");
        const expectedHash = createHash("sha256").update(expectedSql).digest("hex");

        expect(invocation.args).toContain("ON_ERROR_STOP=1");
        expect(invocation.vars["migration_tag"]).toBe(entry.tag);
        expect(invocation.vars["migration_hash"]).toBe(expectedHash);
        expect(invocation.vars["migration_when"]).toBe(String(entry.when));

        const sql = invocation.rawSql;
        const beginPos = sql.indexOf("BEGIN;");
        const lockPos = sql.indexOf("SELECT pg_advisory_xact_lock(42190837);");
        const checkPos = sql.indexOf("AS already_applied \\gset");
        const ifPos = sql.indexOf("\\if :already_applied");
        const elsePos = sql.indexOf("\\else");
        const ddlPos = sql.indexOf(expectedSql.trim());
        const insertPos = sql.indexOf('INSERT INTO "drizzle"."__drizzle_migrations"');
        const endifPos = sql.indexOf("\\endif");
        const commitPos = sql.indexOf("COMMIT;");

        expect(beginPos).toBeGreaterThanOrEqual(0);
        expect(lockPos).toBeGreaterThan(beginPos);
        expect(checkPos).toBeGreaterThan(lockPos);
        expect(ifPos).toBeGreaterThan(checkPos);
        expect(elsePos).toBeGreaterThan(ifPos);
        expect(ddlPos).toBeGreaterThan(elsePos);
        expect(insertPos).toBeGreaterThan(ddlPos);
        expect(endifPos).toBeGreaterThan(insertPos);
        expect(commitPos).toBeGreaterThan(endifPos);

        expect(invocation.skipped).toBe(false);
        expect(invocation.executedSql).toContain(expectedSql.trim());
        expect(invocation.executedSql).toContain('INSERT INTO "drizzle"."__drizzle_migrations"');
      }
    });
  });

  it("skips already-applied migration hashes on re-run and resumes cleanly after partial application", () => {
    const journal = readDrizzleJournal();

    withTempDir("kibitz-ops04-resumable-", (dir) => {
      const binDir = resolve(dir, "bin");
      const statePath = resolve(dir, "state.json");
      spawnSync("mkdir", ["-p", binDir], { encoding: "utf8" });

      // Simulate recovery after migration 0 succeeded and a later migration failed/interrupted.
      const firstEntry = journal.entries[0];
      expect(firstEntry).toBeDefined();
      const firstSql = readFileSync(resolve(DRIZZLE_DIR, `${firstEntry!.tag}.sql`), "utf8");
      const firstHash = createHash("sha256").update(firstSql).digest("hex");

      const partialState: SimulatedPsqlState = {
        appliedHashes: [firstHash],
        invocations: [],
      };
      writeFileSync(statePath, JSON.stringify(partialState), "utf8");
      createStatefulStubPsql(binDir, statePath);

      const env: NodeJS.ProcessEnv = {
        ...sanitizedBaseEnv(),
        PATH: `${binDir}:${sanitizedBaseEnv()["PATH"] ?? "/usr/bin:/bin"}`,
        POSTGRES_USER: "kibitz",
        POSTGRES_DB: "kibitz_suite",
        MIGRATIONS_DIR: DRIZZLE_DIR,
      };

      // Run 1 (resuming from partial state): skips migration 0, applies remaining migrations.
      const resumeRun = spawnSync("sh", [INIT_SCRIPT], {
        cwd: REPO_ROOT,
        env,
        encoding: "utf8",
      });
      expect(resumeRun.status, resumeRun.stderr).toBe(0);
      expect(resumeRun.stdout).toContain(
        `[kibitz-init] Skipping already-applied Drizzle migration ${firstEntry!.tag}`,
      );

      const afterResume = JSON.parse(readFileSync(statePath, "utf8")) as SimulatedPsqlState;
      const resumeMigrations = afterResume.invocations.slice(1);
      expect(resumeMigrations[0]?.skipped).toBe(true);
      expect(resumeMigrations[0]?.executedSql).not.toContain(
        'INSERT INTO "drizzle"."__drizzle_migrations"',
      );
      for (const applied of resumeMigrations.slice(1)) {
        expect(applied.skipped).toBe(false);
        expect(applied.executedSql).toContain('INSERT INTO "drizzle"."__drizzle_migrations"');
      }
      expect(afterResume.appliedHashes.length).toBe(journal.entries.length);

      // Run 2 (full re-run when all migrations are already applied): skips every migration cleanly.
      const invocationCountBeforeRerun = afterResume.invocations.length;
      const rerun = spawnSync("sh", [INIT_SCRIPT], {
        cwd: REPO_ROOT,
        env,
        encoding: "utf8",
      });
      expect(rerun.status, rerun.stderr).toBe(0);

      const afterRerun = JSON.parse(readFileSync(statePath, "utf8")) as SimulatedPsqlState;
      const rerunInvocations = afterRerun.invocations.slice(invocationCountBeforeRerun);
      expect(rerunInvocations.length).toBe(1 + journal.entries.length);

      for (const [index, entry] of journal.entries.entries()) {
        const inv = rerunInvocations[1 + index];
        expect(inv?.skipped).toBe(true);
        expect(inv?.executedSql).not.toContain('INSERT INTO "drizzle"."__drizzle_migrations"');
        expect(rerun.stdout).toContain(
          `[kibitz-init] Skipping already-applied Drizzle migration ${entry.tag}`,
        );
      }
      expect(afterRerun.appliedHashes.length).toBe(journal.entries.length);
    });
  });
});
