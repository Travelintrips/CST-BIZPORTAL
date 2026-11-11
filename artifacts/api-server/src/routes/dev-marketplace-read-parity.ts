import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getDevSession, isDevelopmentEnvironment } from "./dev-auth";

// DEV-only, read-only BizPortal Marketplace parity with Customer Portal.
// No proxy, no credential forwarding, and no production fallback.
const router: IRouter = Router();
function authorize(req: Request, res: Response): boolean {
  if (!isDevelopmentEnvironment()) {
    res.status(404).json({ code: "BIZPORTAL_LOCAL_ENDPOINT_NOT_FOUND", error: "Not found" });
    return false;
  }
  const user = getDevSession(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  if (!["admin", "owner", "super_admin"].includes(user.role.toLowerCase())) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}
function limit(req: Request): number {
  const parsed = Number(req.query.limit ?? 200);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : 200;
}

router.get("/mkt/admin/rfqs", async (req, res): Promise<void> => {
  if (!authorize(req,res)) return;
  try {
    const result = await pool.query(
      `select id as "rfqId", rfq_number as "rfqNumber",
              status::text as "rfqStatus", approval_status as "approvalStatus",
              approval_requested_at as "approvalRequestedAt",
              approval_resolved_at as "approvalResolvedAt",
              buyer_name as "buyerName", buyer_email as "buyerEmail",
              buyer_company as "buyerCompany", buyer_approval_level as "buyerApprovalLevel",
              notes, required_delivery_date as "requiredDeliveryDate",
              created_at as "createdAt"
         from public.mkt_rfqs order by created_at desc, id desc limit $1`,
      [limit(req)],
    );
    res.json({ok:true,data:result.rows,count:result.rows.length});
  } catch (error) {
    req.log.error({error}, "DEV Marketplace RFQ list failed");
    res.status(503).json({error:"DEV Marketplace data unavailable"});
  }
});

router.get("/mkt/admin/purchase-orders", async (req, res): Promise<void> => {
  if (!authorize(req,res)) return;
  try {
    const result = await pool.query(
      `select p.id, p.po_number as "poNumber", p.rfq_id as "rfqId",
              p.company_id as "companyId", p.vendor_id as "vendorId",
              p.status::text as status, p.total_amount as "totalAmount",
              p.grand_total as "grandTotal", p.created_at as "createdAt",
              p.confirmed_at as "confirmedAt", p.cancelled_at as "cancelledAt",
              p.vendor_name_snapshot as "vendorNameSnapshot",
              p.currency_snapshot as "currencySnapshot",
              p.lead_time_days_snapshot as "leadTimeDaysSnapshot",
              r.rfq_number as "rfqNumber", s.name as "vendorName"
         from public.mkt_purchase_orders p
         left join public.mkt_rfqs r on r.id = p.rfq_id
         left join public.suppliers s on s.id = p.vendor_id
        order by p.created_at desc, p.id desc limit $1`,
      [limit(req)],
    );
    res.json({ok:true,data:result.rows,count:result.rows.length});
  } catch (error) {
    req.log.error({error}, "DEV Marketplace PO list failed");
    res.status(503).json({error:"DEV Marketplace data unavailable"});
  }
});
export default router;
