import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "apps/web",
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/ws": { target: "ws://127.0.0.1:4317", ws: true } }
  },
  build: { outDir: "dist", emptyOutDir: true }
});
