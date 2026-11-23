import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "../../..");
const COMPOSE_FILE = resolve(REPO_ROOT, "docker-compose.yml");
const ENV_EXAMPLE_FILE = resolve(REPO_ROOT, ".env.example");
const INIT_SCRIPT = resolve(REPO_ROOT, "docker/postgres/init-db-and-admin.sh");

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
