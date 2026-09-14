import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { pool, getDatabaseUrl } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/health/ready", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.json({
      status: "ok",
      database: "connected",
      databaseProvider: getDatabaseUrl()?.includes("supabase") ? "supabase" : "postgres",
    });
  } catch (error) {
    res.status(503).json({
      status: "degraded",
      database: "unavailable",
      error: error instanceof Error ? error.message : "Database connection failed",
    });
  }
});

export default router;
