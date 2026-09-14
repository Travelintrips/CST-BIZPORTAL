import path from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@shared/api-client-react": path.resolve(import.meta.dirname, "src/shared/api-client-react/index.ts"),
      "@shared/object-storage-web": path.resolve(import.meta.dirname, "src/shared/object-storage-web/index.ts"),
      "@shared/replit-auth-web": path.resolve(import.meta.dirname, "src/shared/replit-auth-web/index.ts"),
      "@shared/product-templates": path.resolve(import.meta.dirname, "src/shared/product-templates/index.ts"),
      "@shared/logistics-constants": path.resolve(import.meta.dirname, "src/shared/logistics-constants/index.ts"),
    },
  },
});