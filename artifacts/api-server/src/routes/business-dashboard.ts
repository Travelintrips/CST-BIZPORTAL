import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import {
  getDevSession,
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
  type DevAuthUser,
} from "./dev-auth";

type LocalRequest = Request & { localUser?: DevAuthUser };

const router: IRouter = Router();

function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function optionalPositiveInteger(value: unknown, field: string): number | null {
  const raw = firstQueryValue(value);
  if (!raw || raw === "all") return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`INVALID_${field.toUpperCase()}`);
  }
  return parsed;
}

function scopedCompanyId(request: LocalRequest): number | null {
  const requested = optionalPositiveInteger(request.query.companyId, "company_id");
  const userCompanyId = request.localUser?.companyId ?? null;
  if (
    requested !== null
    && userCompanyId !== null
    && requested !== userCompanyId
    && !["admin", "owner", "super_admin", "finance", "accounting"].includes(request.localUser?.role ?? "")
  ) {
    throw new Error("COMPANY_FORBIDDEN");
  }
  return requested ?? userCompanyId;
}

function sqlCompanyFilter(
  companyId: number | null,
  column: string,
  values: Array<string | number>,
): string {
  if (companyId === null) return "";
  values.push(companyId);
  return ` and ${column} = $${values.length}`;
}

function numberValue(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function requestError(request: Request, response: Response, error: unknown): void {
  if (error instanceof Error && error.message === "COMPANY_FORBIDDEN") {
    response.status(403).json({ error: "Akses perusahaan tidak diizinkan." });
    return;
  }
  if (error instanceof Error && error.message.startsWith("INVALID_")) {
    response.status(400).json({ error: "Filter perusahaan tidak valid." });
    return;
  }
  request.log.error({ error }, "Local BizPortal business route failed");
  response.status(503).json({ error: "Data bisnis tidak dapat dimuat." });
}

async function authenticateLocalUser(
  request: LocalRequest,
  response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (isDevelopmentEnvironment()) {
      const user = getDevSession(request);
      if (!user) {
        response.status(401).json({ error: "Unauthorized" });
        return;
      }
      request.localUser = user;
      next();
      return;
    }

    const session = getProductionSession(request);
    if (!session) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    const user = await getProductionUser(session);
    if (!user) {
      response.status(403).json({ error: "Forbidden" });
      return;
    }
    request.localUser = user;
    next();
  } catch (error) {
    request.log.error({ error }, "Local business authorization failed");
    response.status(503).json({ error: "Authorization service unavailable." });
  }
}

function requireAdmin(request: LocalRequest, response: Response): boolean {
  if (["admin", "owner", "super_admin", "finance", "accounting"].includes(request.localUser?.role ?? "")) {
    return true;
  }
  response.status(403).json({ error: "Forbidden" });
  return false;
}

router.use(authenticateLocalUser);

router.get("/purchase/dashboard-kpi", async (request, response): Promise<void> => {
  try {
    const companyId = scopedCompanyId(request as LocalRequest);
    const companyValues: Array<string | number> = [];
    const companyFilter = sqlCompanyFilter(companyId, "company_id", companyValues);
    const monthStart = firstQueryValue(request.query.month)
      && firstQueryValue(request.query.year)
      ? `${firstQueryValue(request.query.year)}-${String(firstQueryValue(request.query.month)).padStart(2, "0")}-01`
      : null;
    const monthPlaceholder = companyId === null ? "$1" : "$2";
    const monthFilter = monthStart
      ? ` and confirmed_at >= ${monthPlaceholder}::date and confirmed_at < (${monthPlaceholder}::date + interval '1 month')`
      : " and confirmed_at >= date_trunc('month', current_date) and confirmed_at < date_trunc('month', current_date) + interval '1 month'";
    const companyOnlyValues = companyValues;
    const monthValues = monthStart ? [companyId, monthStart].filter((value): value is string | number => value !== null) : companyOnlyValues;

    const [counts, monthData, topSuppliers] = await Promise.all([
      pool.query<Record<string, unknown>>(
        `select
           coalesce(sum(case when kind = 'rfq' and status not in ('cancelled','done') then 1 else 0 end), 0)::int active_rfqs,
           coalesce(sum(case when kind = 'order' and status <> 'cancelled' then 1 else 0 end), 0)::int active_pos,
           coalesce(sum(case when kind = 'order' and bill_status = 'to_bill' and status <> 'cancelled' then 1 else 0 end), 0)::int to_bill,
           coalesce(sum(case when kind = 'order' and bill_status = 'billed' and payment_status in ('unpaid','partial') then 1 else 0 end), 0)::int billed_unpaid,
           coalesce(sum(case when kind = 'order' and bill_status = 'billed' and payment_status in ('unpaid','partial')
             and due_date is not null and due_date < current_date::text then 1 else 0 end), 0)::int overdue_count,
           coalesce(sum(case when kind = 'order' and bill_status = 'billed' and payment_status in ('unpaid','partial')
             and due_date is not null and due_date < current_date::text
             then greatest(grand_total::numeric - amount_paid::numeric, 0) else 0 end), 0)::float overdue_amount
         from public.purchase_documents
         where true${companyFilter}`,
        companyOnlyValues,
      ),
      pool.query<Record<string, unknown>>(
        `select
           coalesce(sum(case when kind = 'order' and status not in ('cancelled','draft')${monthFilter}
             then grand_total::numeric else 0 end), 0)::float month_spend,
           coalesce(sum(case when kind = 'order' and status <> 'cancelled' and created_at >= current_date then 1 else 0 end), 0)::int new_today
         from public.purchase_documents
         where true${companyFilter}`,
        monthValues,
      ),
      pool.query<{ supplier_name: string | null; total: string }>(
        `select supplier_name, coalesce(sum(grand_total::numeric), 0)::float total
         from public.purchase_documents
         where kind = 'order' and status not in ('cancelled','draft')${monthFilter}${companyFilter}
         group by supplier_name order by total desc limit 3`,
        monthValues,
      ),
    ]);
    const c = counts.rows[0] ?? {};
    const m = monthData.rows[0] ?? {};
    response.json({
      activeRfqs: numberValue(c.active_rfqs),
      activePOs: numberValue(c.active_pos),
      toBill: numberValue(c.to_bill),
      billedUnpaid: numberValue(c.billed_unpaid),
      overdueCount: numberValue(c.overdue_count),
      overdueAmount: numberValue(c.overdue_amount),
      monthSpend: numberValue(m.month_spend),
      newToday: numberValue(m.new_today),
      topSuppliers: topSuppliers.rows.map((row) => ({
        name: row.supplier_name ?? "Tanpa Nama",
        total: numberValue(row.total),
      })),
    });
  } catch (error) {
    requestError(request, response, error);
  }
});

router.get("/sales/dashboard-widget", async (request, response): Promise<void> => {
  try {
    const companyId = scopedCompanyId(request as LocalRequest);
    const values: Array<string | number> = [];
    const companyFilter = sqlCompanyFilter(companyId, "sd.company_id", values);
    const result = await pool.query<{
      active_so_count: string;
      outstanding_invoices_count: string;
      outstanding_amount: string;
      revenue_pipeline_this_month: string;
      revenue_pipeline_so_count: string;
      top3_customers: unknown;
    }>(
      `with pipeline as (
         select customer_name, grand_total::numeric amount
         from public.sales_documents sd
         where kind::text = 'order' and status::text in ('confirmed','done')
           and created_at >= date_trunc('month', current_date)${companyFilter}
       ),
       customers as (
         select coalesce(customer_name, 'Tanpa Nama') name, sum(amount) revenue, count(*) order_count
         from pipeline group by customer_name order by revenue desc limit 3
       )
       select
         (select count(*) from public.sales_documents sd where kind::text = 'order'
           and status::text not in ('done','cancelled')${companyFilter})::text active_so_count,
         (select count(*) from public.sales_documents sd where kind::text = 'order' and invoice_status::text = 'invoiced'
           and payment_status::text in ('unpaid','partial','overdue') and status::text <> 'cancelled'${companyFilter})::text outstanding_invoices_count,
         (select coalesce(sum(greatest(sd.grand_total::numeric - coalesce(sd.amount_paid, 0), 0)), 0)
          from public.sales_documents sd where kind::text = 'order' and invoice_status::text = 'invoiced'
           and payment_status::text in ('unpaid','partial','overdue') and status::text <> 'cancelled'${companyFilter})::text outstanding_amount,
         coalesce((select sum(amount) from pipeline), 0)::text revenue_pipeline_this_month,
         (select count(*) from pipeline)::text revenue_pipeline_so_count,
         coalesce((select json_agg(json_build_object('name', name, 'revenue', revenue, 'orderCount', order_count))
           from customers), '[]'::json) top3_customers`,
      values,
    );
    const row = result.rows[0] ?? {};
    response.json({
      activeSoCount: numberValue(row.active_so_count),
      outstandingInvoicesCount: numberValue(row.outstanding_invoices_count),
      outstandingAmount: numberValue(row.outstanding_amount),
      revenuePipelineThisMonth: numberValue(row.revenue_pipeline_this_month),
      revenuePipelineSoCount: numberValue(row.revenue_pipeline_so_count),
      top3Customers: Array.isArray(row.top3_customers) ? row.top3_customers : [],
    });
  } catch (error) {
    requestError(request, response, error);
  }
});

router.get("/logistic/orders/dashboard-kpi", async (request, response): Promise<void> => {
  try {
    const companyId = scopedCompanyId(request as LocalRequest);
    const values: Array<string | number> = [];
    const companyFilter = sqlCompanyFilter(companyId, "company_id", values);
    const [phases, today, revenue] = await Promise.all([
      pool.query<Record<string, unknown>>(
        `select
           coalesce(sum(case when status in ('Order Received','Admin Review') then 1 else 0 end),0)::int pre_ops,
           coalesce(sum(case when status in ('RFQ Sent','Quote Received','Customer Approval','Vendor Confirmed') then 1 else 0 end),0)::int quotation,
           coalesce(sum(case when status in ('In Progress','Pickup','In Transit','Arrived','Delivered') then 1 else 0 end),0)::int in_transit,
           coalesce(sum(case when status in ('POD Uploaded','Invoice Issued','Payment Received') then 1 else 0 end),0)::int billing,
           coalesce(sum(case when status = 'Completed' then 1 else 0 end),0)::int completed_all,
           coalesce(sum(case when status = 'Cancelled' then 1 else 0 end),0)::int cancelled_all,
           count(*)::int total_all
         from public.logistic_orders where true${companyFilter}`,
        values,
      ),
      pool.query<Record<string, unknown>>(
        `select
           coalesce(sum(case when created_at >= current_date then 1 else 0 end),0)::int new_today,
           coalesce(sum(case when status = 'Completed' and updated_at >= current_date then 1 else 0 end),0)::int completed_today,
           coalesce(sum(case when status not in ('Completed','Cancelled') and updated_at < now() - interval '7 days' then 1 else 0 end),0)::int stalled
         from public.logistic_orders where true${companyFilter}`,
        values,
      ),
      pool.query<Record<string, unknown>>(
        `select
           coalesce(sum(case when status <> 'Cancelled' then grand_total::numeric else 0 end),0)::float active_revenue,
           coalesce(sum(case when status = 'Completed' and updated_at >= date_trunc('month', now())
             then grand_total::numeric else 0 end),0)::float month_completed_revenue
         from public.logistic_orders where true${companyFilter}`,
        values,
      ),
    ]);
    const p = phases.rows[0] ?? {};
    const t = today.rows[0] ?? {};
    const r = revenue.rows[0] ?? {};
    response.json({
      phases: {
        preOps: numberValue(p.pre_ops),
        quotation: numberValue(p.quotation),
        inTransit: numberValue(p.in_transit),
        billing: numberValue(p.billing),
      },
      completedAll: numberValue(p.completed_all),
      cancelledAll: numberValue(p.cancelled_all),
      totalAll: numberValue(p.total_all),
      newToday: numberValue(t.new_today),
      completedToday: numberValue(t.completed_today),
      stalled: numberValue(t.stalled),
      activeRevenue: numberValue(r.active_revenue),
      monthCompletedRevenue: numberValue(r.month_completed_revenue),
    });
  } catch (error) {
    requestError(request, response, error);
  }
});

router.get("/sport-center/kpi-live", async (request, response): Promise<void> => {
  if (!requireAdmin(request as LocalRequest, response)) return;
  try {
    const companyId = scopedCompanyId(request as LocalRequest);
    const rawDate = firstQueryValue(request.query.date);
    const targetDate = rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
    const values: Array<string | number | null> = [targetDate];
    if (companyId !== null) values.push(companyId);
    const companyOnlyValues: Array<string | number> = companyId === null ? [] : [companyId];
    const companyFilter = companyId === null ? "" : ` and company_id = $2`;
    const companyOnlyFilter = companyId === null ? "" : " and company_id = $1";
    const accountingCompanyFilter = companyId === null ? "" : ` and company_id = $2`;
    const [
      revenue,
      bookings,
      activeBookings,
      checkins,
      members,
      refunds,
      occupied,
      facilities,
      netProfit,
    ] = await Promise.all([
      pool.query<{ amount: string }>(`select coalesce(sum(total_debit),0)::text amount from public.accounting_entries
        where source in ('sport_center_booking','sport_center_membership') and status = 'posted'
          and date = coalesce($1::date, current_date)${accountingCompanyFilter}`, values),
      pool.query<{ count: string }>(`select count(*)::text count from public.sport_bookings
        where booking_date = coalesce($1::date, current_date) and status <> 'cancelled'${companyFilter}`, values),
      pool.query<{ count: string }>(`select count(*)::text count from public.sport_bookings
        where booking_date = coalesce($1::date, current_date) and status in ('confirmed','checked_in')${companyFilter}`, values),
      pool.query<{ count: string }>(`select count(*)::text count from public.sport_bookings
        where date(checked_in_at) = coalesce($1::date, current_date) and status = 'checked_in'${companyFilter}`, values),
      pool.query<{ count: string }>(`select count(*)::text count from public.sport_members
        where status = 'active'${companyOnlyFilter}`, companyOnlyValues),
      pool.query<{ amount: string }>(`select coalesce(sum(refund_amount),0)::text amount from public.sport_refunds
        where date(created_at) = coalesce($1::date, current_date) and status in ('pending','paid')${companyFilter}`, values),
      pool.query<{ hours: string }>(`select coalesce(sum(duration_hours),0)::text hours from public.sport_bookings
        where booking_date = coalesce($1::date, current_date) and status <> 'cancelled'${companyFilter}`, values),
      pool.query<{ count: string }>(`select count(*)::text count from public.sport_facilities
        where is_active = true${companyOnlyFilter}`, companyOnlyValues),
      pool.query<{ amount: string }>(`select coalesce(sum(case when source in
        ('sport_center_booking','sport_center_membership') then total_debit
        when source in ('sport_center_refund','sport_center_booking_refund','sport_center_booking_reversal') then -total_debit
        else 0 end),0)::text amount from public.accounting_entries
        where date = coalesce($1::date, current_date) and status = 'posted'
          and source in ('sport_center_booking','sport_center_membership','sport_center_refund','sport_center_booking_refund','sport_center_booking_reversal')
          ${accountingCompanyFilter}`, values),
    ]);
    const occupiedHours = numberValue(occupied.rows[0]?.hours);
    const availableHours = Math.max(numberValue(facilities.rows[0]?.count) * 14, 1);
    response.json({
      revenue_today: numberValue(revenue.rows[0]?.amount),
      bookings_today: numberValue(bookings.rows[0]?.count),
      active_bookings_now: numberValue(activeBookings.rows[0]?.count),
      occupancy_today: Math.min(100, Math.round((occupiedHours / availableHours) * 100)),
      occupied_hours_today: occupiedHours,
      available_hours_today: availableHours,
      checkins_today: numberValue(checkins.rows[0]?.count),
      members_active: numberValue(members.rows[0]?.count),
      refunds_today: numberValue(refunds.rows[0]?.amount),
      net_profit_today: numberValue(netProfit.rows[0]?.amount),
    });
  } catch (error) {
    requestError(request, response, error);
  }
});

router.get("/internal-tasks", async (request, response): Promise<void> => {
  try {
    const companyId = scopedCompanyId(request as LocalRequest);
    const values: Array<string | number> = [];
    const filters = sqlCompanyFilter(companyId, "t.company_id", values);
    const limit = Math.min(Math.max(Number(firstQueryValue(request.query.limit) ?? 50), 1), 200);
    values.push(limit);
    const result = await pool.query<Record<string, unknown>>(
      `select t.id, t.title, t.status, t.priority, t.department, t.deadline, t.created_at,
              u.id assignee_id, u.name assignee_name, u.email assignee_email
         from public.internal_tasks t
         left join public.users u on u.id::text = t.assigned_user_id::text
        where true${filters}
        order by t.created_at desc limit $${values.length}`,
      values,
    );
    response.json(result.rows.map((row) => ({
      task: {
        id: numberValue(row.id),
        title: row.title,
        status: row.status,
        priority: row.priority,
        department: row.department,
        deadline: row.deadline,
        createdAt: row.created_at,
      },
      assignee: row.assignee_id === null || row.assignee_id === undefined
        ? null
        : { id: numberValue(row.assignee_id), name: row.assignee_name, email: row.assignee_email },
    })));
  } catch (error) {
    requestError(request, response, error);
  }
});

router.get("/internal-tasks/stats/summary", async (request, response): Promise<void> => {
  try {
    const companyId = scopedCompanyId(request as LocalRequest);
    const values: Array<string | number> = [];
    const filters = sqlCompanyFilter(companyId, "company_id", values);
    const result = await pool.query<Record<string, unknown>>(
      `select coalesce(department, 'Unassigned') department, count(*)::int total,
              count(*) filter (where status = 'open')::int open,
              count(*) filter (where status = 'in_progress')::int in_progress,
              count(*) filter (where status = 'completed')::int completed,
              count(*) filter (where deadline < now() and status not in ('completed','cancelled'))::int overdue
         from public.internal_tasks where true${filters} group by department order by department`,
      values,
    );
    response.json(result.rows);
  } catch (error) {
    requestError(request, response, error);
  }
});

router.get("/intelligence-alerts/summary", async (request, response): Promise<void> => {
  if (!requireAdmin(request as LocalRequest, response)) return;
  try {
    const companyId = scopedCompanyId(request as LocalRequest);
    const values: Array<string | number> = [];
    const filters = sqlCompanyFilter(companyId, "company_id", values);
    const result = await pool.query<{ severity: string; status: string; count: string }>(
      `select severity, status, count(*)::text count
         from public.intelligence_alerts where true${filters}
        group by severity, status`,
      values,
    );
    const summary = {
      total: 0,
      open: { critical: 0, warning: 0, info: 0 },
      acknowledged: { critical: 0, warning: 0, info: 0 },
    };
    for (const row of result.rows) {
      const severity = row.severity as "critical" | "warning" | "info";
      const status = row.status as "open" | "acknowledged";
      if (!(severity in summary.open) || !(status in summary)) continue;
      summary.total += numberValue(row.count);
      summary[status][severity] += numberValue(row.count);
    }
    response.json(summary);
  } catch (error) {
    requestError(request, response, error);
  }
});

router.get("/intelligence-alerts", async (request, response): Promise<void> => {
  if (!requireAdmin(request as LocalRequest, response)) return;
  try {
    const companyId = scopedCompanyId(request as LocalRequest);
    const values: Array<string | number> = [];
    const filters = sqlCompanyFilter(companyId, "company_id", values);
    const status = firstQueryValue(request.query.status);
    const statusFilter = status ? ` and status = $${values.length + 1}` : "";
    if (status) values.push(status);
    const limit = Math.min(Math.max(Number(firstQueryValue(request.query.limit) ?? 50), 1), 200);
    values.push(limit);
    const result = await pool.query<Record<string, unknown>>(
      `select id, title, message, severity, status, created_at
         from public.intelligence_alerts where true${filters}${statusFilter}
        order by created_at desc limit $${values.length}`,
      values,
    );
    response.json({
      alerts: result.rows.map((row) => ({
        id: numberValue(row.id),
        title: row.title,
        message: row.message,
        severity: row.severity,
        status: row.status,
        createdAt: row.created_at,
      })),
      total: result.rows.length,
    });
  } catch (error) {
    requestError(request, response, error);
  }
});

router.get("/audit-logs", async (request, response): Promise<void> => {
  try {
    const companyId = scopedCompanyId(request as LocalRequest);
    const limit = Math.min(Math.max(Number(firstQueryValue(request.query.limit) ?? 50), 1), 500);
    const offset = Math.max(Number(firstQueryValue(request.query.offset) ?? 0), 0);
    const params = companyId === null ? [limit, offset] : [companyId, limit, offset];
    const companyPredicate = companyId === null
      ? "al.company_id is null or al.company_id is not null"
      : "al.company_id is null or al.company_id = $1";
    const result = await pool.query<Record<string, unknown>>(
      `select al.id, al.company_id, al.branch_id, al.user_id, al.user_email,
              al.action, al.module, al.reference_id, al.old_data, al.new_data, al.created_at,
              count(*) over()::int total_count
         from public.erp_audit_logs al
        where (${companyPredicate})
        order by al.created_at desc limit $${companyId === null ? 1 : 2} offset $${companyId === null ? 2 : 3}`,
      params,
    );
    response.json({
      rows: result.rows.map((row) => ({
        id: numberValue(row.id),
        company_id: row.company_id,
        branch_id: row.branch_id,
        user_id: row.user_id,
        user_email: row.user_email,
        action: row.action,
        module: row.module,
        reference_id: row.reference_id,
        old_data: row.old_data,
        new_data: row.new_data,
        created_at: row.created_at,
      })),
      total: numberValue(result.rows[0]?.total_count),
      limit,
      offset,
    });
  } catch (error) {
    requestError(request, response, error);
  }
});

export default router;