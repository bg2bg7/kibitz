import { serve } from "@hono/node-server";
import { createIdApp } from "./app.js";

const port = Number(process.env["ID_SERVER_PORT"] ?? 4001);
const app = createIdApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[id] listening on http://localhost:${info.port}`);
});
