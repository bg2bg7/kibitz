import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url:
      process.env["DATABASE_URL"] ??
      "postgresql://kibitz:kibitz_dev_password@localhost:5432/kibitz_suite",
  },
});
