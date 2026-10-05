import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT || 4175),
    allowedHosts: true,
    proxy: {
      "/api": {
        target: process.env.FLEET_API_ORIGIN || "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
  preview: { host: "0.0.0.0", port: Number(process.env.PORT || 4175), allowedHosts: true },
  build: { outDir: "dist", emptyOutDir: true },
});
