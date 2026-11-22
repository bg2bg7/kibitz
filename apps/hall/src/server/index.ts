import type { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import { attachHallWebSocketServer, createHallApp } from "./app.js";

const port = Number(process.env["HALL_SERVER_PORT"] ?? 4003);
const app = createHallApp();

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[hall] HTTP + WS listening on http://localhost:${info.port}`);
});

attachHallWebSocketServer(server as unknown as HttpServer);
