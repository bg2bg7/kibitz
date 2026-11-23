import { existsSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { attachHallWebSocketServer, createHallApp, isHallWebSocketEnabled } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const envPath of [
  path.resolve(__dirname, "../../.env"),
  path.resolve(__dirname, "../../../../.env"),
]) {
  if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
}

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
