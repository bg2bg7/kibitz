import { Hono } from "hono";

export function createLectureApp() {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "lecture",
    }),
  );

  app.get("/api/primers", (c) =>
    c.json({
      visibility: "public_moderated",
      items: [
        {
          id: "primer-italian-800-1200",
          title: "Italian Game Essentials (800-1200 Primer)",
          format: "pgna-v1.0",
          requiresAuth: false,
        },
      ],
    }),
  );

  app.get("/api/assignments", (c) => {
    const authHeader = c.req.header("authorization");
    if (!authHeader) {
      return c.json({ error: "Authentication required for coach assignments." }, 401);
    }
    return c.json({
      items: [],
      interactionPolicy: "emoji_only",
    });
  });

  return app;
}
