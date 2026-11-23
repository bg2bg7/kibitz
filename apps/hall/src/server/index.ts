import { existsSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { attachHallWebSocketServer, createHallApp } from "./app.js";

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
const app = createHallApp();

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[hall] HTTP + WS listening on http://localhost:${info.port}`);
});

attachHallWebSocketServer(server as unknown as HttpServer);
