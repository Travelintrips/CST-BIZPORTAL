import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getRuntimeDatabaseUrl, pool } from "@workspace/db";
import { resolveSmtpConfig } from "../lib/smtp";
import {
  initializeProductionSessionSigning,
  isDevelopmentEnvironment,
} from "./dev-auth";

const router: IRouter = Router();

router.get("/health/live", (_req, res) => {
  res.json({ status: "ok" });
});

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/health/smtp", async (_req, res) => {
  try {
    const config = await resolveSmtpConfig();
    res.json({
      status: "ok",
      ready: true,
      source: config.source,
    });
  } catch {
    res.status(503).json({
      status: "degraded",
      ready: false,
    });
  }
});

router.get("/health/ready", async (_req, res) => {
  try {
    await pool.query<{ ok: number }>("select 1 as ok");
    const runtimeDatabaseUrl = await getRuntimeDatabaseUrl();
    if (!isDevelopmentEnvironment()) {
      await initializeProductionSessionSigning();
    }
    res.json({
      status: "ok",
      ready: true,
      database: "connected",
      authSessionSigning: "ready",
      databaseProvider: runtimeDatabaseUrl.includes("supabase") ? "supabase" : "postgres",
    });
  } catch (error) {
    res.status(503).json({
      status: "degraded",
      ready: false,
      database: "unavailable-or-auth-not-ready",
      authSessionSigning: "not-ready",
      error: error instanceof Error ? error.message : "Runtime readiness failed",
    });
  }
});

export default router;
