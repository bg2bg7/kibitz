import { serve } from "@hono/node-server";
import { createLectureApp } from "./app.js";

const port = Number(
  process.env["LECTURE_SERVER_PORT"] ?? process.env["KIBITZ_SERVER_PORT"] ?? 4002,
);
const app = createLectureApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[lecture] listening on http://localhost:${info.port}`);
});
