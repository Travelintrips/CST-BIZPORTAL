import { Router, type IRouter } from "express";
import healthRouter from "./health";
import companiesRouter from "./companies";
import bankReconciliationRouter from "./bank-reconciliation";
import reconClassificationRouter from "./recon-classification";
import accountingRouter from "./accounting";
import purchaseWorkflowRouter from "./purchase-workflow";
import businessDashboardRouter from "./business-dashboard";
import localProductionAuthRouter from "./local-production-auth";
import salesCoreRouter from "./sales-core";
import adminRealtimeRouter from "./admin-realtime";
import legacyReadParityRouter from "./legacy-read-parity";
import aiReviewReadParityRouter from "./ai-review-read-parity";
import cashBankReadParityRouter from "./cash-bank-read-parity";
import accountingSettingsReadParityRouter from "./accounting-settings-read-parity";
import fleetIntelligenceRouter from "./fleet-intelligence";
import {
  createDevAuthRouter,
  getDevSession,
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
} from "./dev-auth";
import { pool } from "@workspace/db";

const router: IRouter = Router();

router.get("/", (_request, response) => {
  response.json({ status: "ok", service: "cst-bizportal-api" });
});

router.use(healthRouter);

router.use(createDevAuthRouter());

// Production auth is local to this deployment and is mounted before the
// remaining API-owned routes.
router.use(localProductionAuthRouter);

router.post("/auth/email-login", (_request, response) => {
  response.status(404).json({ error: "Not found" });
});

router.use(companiesRouter);
router.use(bankReconciliationRouter);
router.use(reconClassificationRouter);
router.use(accountingRouter);
router.use(purchaseWorkflowRouter);
router.use(businessDashboardRouter);
router.use(salesCoreRouter);
router.use(adminRealtimeRouter);
router.use(legacyReadParityRouter);
router.use(aiReviewReadParityRouter);
router.use(cashBankReadParityRouter);
router.use(accountingSettingsReadParityRouter);
router.use("/logistics/fleet", fleetIntelligenceRouter);

router.post("/sport-center/payments/:id/void", async (req, res): Promise<void> => {
  const rawId = req.params.id;
  const paymentId = Number(rawId);
  if (!/^[1-9]\d*$/.test(rawId ?? "") || !Number.isSafeInteger(paymentId)) {
    res.status(400).json({ error: "ID pembayaran tidak valid." });
    return;
  }

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < 10) {
    res.status(400).json({ error: "Alasan void/reversal minimal 10 karakter." });
    return;
  }

  let actor: string | null = null;
  try {
    if (isDevelopmentEnvironment()) {
      actor = getDevSession(req)?.email ?? null;
    } else {
      const session = getProductionSession(req);
      if (session) {
        const user = await getProductionUser(session);
        actor = user?.email ?? null;
      }
    }
  } catch (error) {
    req.log.error({ error, paymentId }, "Sport Center payment authorization failed");
    res.status(503).json({ error: "Authorization service unavailable." });
    return;
  }

  if (!actor) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const result = await pool.query(
      "SELECT sport_center.void_payment_for_recurring_replacement($1, $2, $3) AS audit",
      [paymentId, actor, reason],
    );
    res.json(result.rows[0]?.audit ?? null);
  } catch (error) {
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("PAYMENT_NOT_FOUND")) {
      res.status(404).json({ error: "Pembayaran tidak ditemukan." });
      return;
    }
    if (message.includes("DUPLICATE_RECURRING_PAYMENT")) {
      res.status(409).json({
        error: "Recurring series ini sudah memiliki pembayaran aktif.",
        code: "DUPLICATE_RECURRING_PAYMENT",
      });
      return;
    }
    if (code === "23505") {
      res.status(409).json({ error: "Pembayaran recurring bentrok dengan transaksi aktif lain." });
      return;
    }
    req.log.error({ error, paymentId }, "Sport Center payment void failed");
    res.status(503).json({ error: "Void/reversal pembayaran belum tersedia." });
  }
});

router.use((_request, response) => {
  response.status(404).json({
    error: "Endpoint tidak tersedia di backend mandiri CST-BIZPORTAL",
    code: "BIZPORTAL_LOCAL_ENDPOINT_NOT_FOUND",
  });
});

export default router;
