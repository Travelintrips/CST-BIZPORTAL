import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { getDevSession, getProductionSession, getProductionUser, isDevelopmentEnvironment } from "./dev-auth";

// DEV-only, read-only BizPortal Marketplace parity with Customer Portal.
// No proxy, no credential forwarding, and no production fallback.
const router: IRouter = Router();
async function authorize(req: Request, res: Response): Promise<boolean> {
  // This DEV-only endpoint must never become available on the PROD runtime.
  if (!isDevelopmentEnvironment()) {
    res.status(404).json({ code: "BIZPORTAL_LOCAL_ENDPOINT_NOT_FOUND", error: "Not found" });
    return false;
  }

  // The separated BizPortal uses Supabase OTP -> its own signed session cookie.
  // Never trust a role supplied by Customer Portal, a header, or a JWT user_metadata field.
  let user = getDevSession(req);
  if (!user) {
    const verifiedSession = getProductionSession(req);
    if (verifiedSession) {
      try {
        user = await getProductionUser(verifiedSession);
      } catch (error) {
        req.log?.error({ error }, "Marketplace DEV admin session lookup failed");
        res.status(503).json({ error: "Authorization service unavailable" });
        return false;
      }
      if (!user) {
        res.status(403).json({ error: "Forbidden" });
        return false;
      }
    }
  }

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
  if (!(await authorize(req,res))) return;
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
  if (!(await authorize(req,res))) return;
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

// DEV-only, read-only finance readiness of the existing Marketplace PO lifecycle.
// Never create a vendor invoice, AP, payment or journal from this diagnostic route.
router.get("/mkt/admin/purchase-orders/:id/finance-readiness", async (req, res): Promise<void> => {
  if (!(await authorize(req, res))) return;
  const rawId = String(req.params.id ?? "");
  const poId = Number(rawId);
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(poId)) {
    res.status(400).json({ error: "Invalid PO ID" });
    return;
  }
  try {
    const result = await pool.query(
      `select p.id, p.po_number as "poNumber", p.company_id as "companyId",
              p.status::text as status, p.payment_status as "paymentStatus",
              (select count(*)::int from public.mkt_po_goods_receipts gr
                join public.mkt_po_shipments sh on sh.id=gr.shipment_id
                where sh.po_id=p.id) as "receiptCount",
              (select count(*)::int from public.vendor_invoices vi
                where vi.mkt_purchase_order_id=p.id) as "vendorInvoiceCount",
              (select count(*)::int from public.vendor_invoices vi
                where vi.mkt_purchase_order_id=p.id
                and vi.status='ready_for_ap' and vi.three_way_match_status='passed') as "matchedVendorInvoiceCount",
              (select count(*)::int from public.mkt_ap_preparations ap
                where ap.mkt_purchase_order_id=p.id) as "apPreparationCount",
              (select count(*)::int from public.mkt_accounting_handoffs ah
                where ah.mkt_purchase_order_id=p.id) as "accountingHandoffCount"
         from public.mkt_purchase_orders p where p.id=$1 limit 1`,
      [poId],
    );
    const po = result.rows[0];
    if (!po) {
      res.status(404).json({ error: "Marketplace PO not found" });
      return;
    }
    const blockers: string[] = [];
    if (po.companyId == null) blockers.push("COMPANY_UNASSIGNED");
    if (Number(po.receiptCount) === 0) blockers.push("GOODS_RECEIPT_MISSING");
    if (Number(po.vendorInvoiceCount) === 0) blockers.push("VENDOR_INVOICE_MISSING");
    else if (Number(po.matchedVendorInvoiceCount) === 0) blockers.push("THREE_WAY_MATCH_NOT_PASSED");
    if (Number(po.apPreparationCount) === 0) blockers.push("AP_PREPARATION_MISSING");
    if (Number(po.accountingHandoffCount) === 0) blockers.push("ACCOUNTING_HANDOFF_MISSING");
    res.json({ ok: true, readOnly: true, environment: "development", data: po, blockers });
  } catch (error) {
    req.log?.error({ error }, "DEV Marketplace finance readiness failed");
    res.status(503).json({ error: "Marketplace finance readiness unavailable" });
  }
});

export default router;
