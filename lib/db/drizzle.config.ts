import { defineConfig } from "drizzle-kit";
import path from "path";
import { getDatabaseUrl } from "./src/connection";

const databaseUrl = getDatabaseUrl();

if (!databaseUrl) {
  throw new Error("A Supabase Postgres URL is required for Drizzle commands");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
