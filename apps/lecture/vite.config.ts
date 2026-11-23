import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5172,
    strictPort: true,
  },
  preview: {
    port: 5172,
    strictPort: true,
  },
  build: {
    outDir: "dist-web",
  },
});
