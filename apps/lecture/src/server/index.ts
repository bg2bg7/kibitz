import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createLectureApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const envPath of [
  path.resolve(__dirname, "../../.env"),
  path.resolve(__dirname, "../../../../.env"),
]) {
  if (existsSync(envPath) && typeof process.loadEnvFile === "function") {
    process.loadEnvFile(envPath);
  }
}

const port = Number(
  process.env["LECTURE_SERVER_PORT"] ?? process.env["KIBITZ_SERVER_PORT"] ?? 4002,
);
const app = createLectureApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[lecture] listening on http://localhost:${info.port}`);
});
