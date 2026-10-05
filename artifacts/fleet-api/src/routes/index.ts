import { Router, type IRouter } from "express";
import fleetIntelligenceRouter from "./fleet-intelligence";
import localProductionAuthRouter from "./local-production-auth";
import { createDevAuthRouter } from "./dev-auth";

const router: IRouter = Router();

router.get("/", (_req, res) => {
  res.json({ status: "ok", service: "fleet-intelligence-api" });
});

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", service: "fleet-intelligence-api" });
});

router.use(createDevAuthRouter());
router.use(localProductionAuthRouter);
router.use("/logistics/fleet", fleetIntelligenceRouter);

router.use((_req, res) => {
  res.status(404).json({ error: "Fleet endpoint not found", code: "FLEET_ENDPOINT_NOT_FOUND" });
});

export default router;
