import { serve } from "@hono/node-server";
import { createKibitzApp } from "./app.js";

const port = Number(process.env["KIBITZ_SERVER_PORT"] ?? 4002);
const app = createKibitzApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[kibitz] listening on http://localhost:${info.port}`);
});
