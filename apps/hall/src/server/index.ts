import { existsSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { attachHallWebSocketServer, createHallApp, isHallWebSocketEnabled } from "./app.js";

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

const port = Number(process.env["HALL_SERVER_PORT"] ?? 4003);
const wsEnabled = isHallWebSocketEnabled(process.env);
const app = createHallApp({ wsEnabled });

const server = serve({ fetch: app.fetch, port }, (info) => {
  if (wsEnabled) {
    console.log(
      `[hall] HTTP + dev WS (/ws explicitly enabled via HALL_ENABLE_DEV_WS) listening on http://localhost:${info.port}`,
    );
  } else {
    console.log(`[hall] HTTP listening on http://localhost:${info.port} (WS /ws disabled)`);
  }
});

if (wsEnabled) {
  attachHallWebSocketServer(server as unknown as HttpServer);
}
