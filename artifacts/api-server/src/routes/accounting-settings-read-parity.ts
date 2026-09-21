import { Router, type IRouter, type Request } from "express";
import { pool } from "@workspace/db";
import {
  getDevSession,
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
  type DevAuthUser,
} from "./dev-auth";

const router: IRouter = Router();

type AccountingReadRequest = Request & { accountingUser?: DevAuthUser };

router.use(async (request, response, next) => {
  try {
    const user = isDevelopmentEnvironment()
      ? getDevSession(request)
      : (() => {
          const session = getProductionSession(request);
          return session ? getProductionUser(session) : Promise.resolve(null);
        })();
    const resolvedUser = await user;
    const role = resolvedUser?.role?.toLowerCase();

    if (!resolvedUser) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!role || !["admin", "owner", "finance", "accounting"].includes(role)) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }

    (request as AccountingReadRequest).accountingUser = resolvedUser;
    next();
  } catch (error) {
    request.log.error({ error }, "Accounting parity authorization failed");
    response.status(503).json({ error: "Authorization service unavailable." });
  }
});

function first(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function requestedCompanyId(request: Request): number | null {
  const raw = first(request.query.company)
    ?? first(request.query.companyId)
    ?? first(request.query.company_id);
  const sessionCompanyId = (request as AccountingReadRequest).accountingUser?.companyId ?? null;

  if (!raw || raw === "all") return sessionCompanyId;

  const companyId = Number(raw);
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error("INVALID_COMPANY");
  if (sessionCompanyId !== null && sessionCompanyId !== companyId) throw new Error("INVALID_COMPANY");
  return companyId;
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value ?? ""));
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

router.get("/accounting/wa-report/settings", async (request, response): Promise<void> => {
  try {
    const result = await pool.query(
      `select id, enabled, send_hour_wib, recipients,
              last_sent_date, last_sent_month, last_status, last_monthly_status
         from public.whatsapp_report_settings
        where id = 1
        limit 1`,
    );

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      response.json({
        id: 1,
        enabled: false,
        sendHourWib: 22,
        recipients: [],
        lastSentDate: null,
        lastSentMonth: null,
        lastStatus: null,
        lastMonthlyStatus: null,
      });
      return;
    }

    let recipients: string[] = [];
    if (Array.isArray(row.recipients)) {
      recipients = row.recipients.map(String);
    } else if (typeof row.recipients === "string") {
      try {
        const parsed = JSON.parse(row.recipients);
        recipients = Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        recipients = [];
      }
    }

    response.json({
      id: Number(row.id),
      enabled: Boolean(row.enabled),
      sendHourWib: Number(row.send_hour_wib ?? 22),
      recipients,
      lastSentDate: row.last_sent_date == null ? null : String(row.last_sent_date),
      lastSentMonth: row.last_sent_month == null ? null : String(row.last_sent_month),
      lastStatus: row.last_status == null ? null : String(row.last_status),
      lastMonthlyStatus: row.last_monthly_status == null ? null : String(row.last_monthly_status),
    });
  } catch (error) {
    request.log.error({ error }, "Standalone WA report settings lookup failed");
    response.status(503).json({ error: "WhatsApp report settings unavailable." });
  }
});

router.get("/accounting/revenue-mappings", async (request, response): Promise<void> => {
  let companyId: number | null;
  try {
    companyId = requestedCompanyId(request);
  } catch {
    response.status(400).json({ error: "Perusahaan tidak valid" });
    return;
  }

  if (companyId === null) {
    response.status(400).json({ error: "companyId required" });
    return;
  }

  try {
    const result = await pool.query(
      `select
         m.id,
         m.company_id,
         m.module_key,
         m.service_key,
         m.label,
         m.revenue_account_id,
         m.is_active,
         m.created_at,
         m.updated_at,
         a.code as revenue_account_code,
         a.name as revenue_account_name
       from public.accounting_revenue_mappings m
       left join public.chart_of_accounts a on a.id = m.revenue_account_id
       where m.company_id = $1
       order by m.module_key, m.service_key, m.label, m.id`,
      [companyId],
    );

    response.json(result.rows.map((row: Record<string, unknown>) => ({
      id: Number(row.id),
      companyId: Number(row.company_id),
      moduleKey: String(row.module_key),
      serviceKey: String(row.service_key),
      label: String(row.label),
      revenueAccountId: Number(row.revenue_account_id),
      revenueAccountCode: row.revenue_account_code == null ? null : String(row.revenue_account_code),
      revenueAccountName: row.revenue_account_name == null ? null : String(row.revenue_account_name),
      isActive: row.is_active === true,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    })));
  } catch (error) {
    request.log.error({ error, companyId }, "Standalone revenue mappings lookup failed");
    response.status(503).json({ error: "Revenue mappings unavailable." });
  }
});

export default router;
