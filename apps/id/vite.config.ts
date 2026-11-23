import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export default defineConfig({
  envDir: REPO_ROOT,
  envPrefix: "VITE_",
  plugins: [react(), tailwindcss()],
  server: {
    port: 5171,
    strictPort: true,
  },
  preview: {
    port: 5171,
    strictPort: true,
  },
  build: {
    outDir: "dist-web",
  },
});
