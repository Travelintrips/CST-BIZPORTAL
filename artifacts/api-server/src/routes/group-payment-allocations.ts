import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { authenticateAdmin } from "./admin-auth";
import { isDevelopmentEnvironment } from "./dev-auth";

const router: IRouter = Router();
/**
 * DEV-only endpoint. No payment, booking, or accounting journal writes.
 * Do not enable in PROD before journal reclassification is approved.
 */
router.post("/sport-center/group-payments/:paymentId/allocate", authenticateAdmin, async (req, res): Promise<void> => {
  if (!isDevelopmentEnvironment()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const raw = req.params.paymentId;
  const paymentId = Number(raw);
  const groupRef = typeof req.body?.groupRef === "string" ? req.body.groupRef.trim() : "";
  if (!/^[1-9]\d*$/.test(raw ?? "") || !Number.isSafeInteger(paymentId) || !groupRef || groupRef.length > 128) {
    res.status(400).json({ error: "Invalid payment or group reference" });
    return;
  }
  try {
    // The PostgreSQL function uses a transaction-scoped advisory lock, group-total
    // checks and unique (payment_id, booking_id) constraints for safe retries.
    const result = await pool.query(
      "SELECT booking_id, allocated_amount, was_inserted FROM sport_center.allocate_group_payment($1::integer, $2::text)",
      [paymentId, groupRef],
    );
    res.json({
      paymentId, groupRef,
      allocations: result.rows,
      count: result.rows.length,
      createdCount: result.rows.filter((r) => r.was_inserted === true).length,
    });
  } catch (error) {
    req.log.error({ error, paymentId }, "Group payment allocation rejected");
    res.status(409).json({ error: "Allocation rejected; verify payment method, group totals, or existing allocations" });
  }
});
export default router;
