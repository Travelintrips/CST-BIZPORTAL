import { Router, type IRouter, type Request } from "express";
import { pool } from "@workspace/db";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";

const router: IRouter = Router();
router.use(authenticateAdmin);

function parseCompanyId(request: Request): number | null {
  const raw = request.query.companyId ?? request.query.company;
  if (raw === undefined || raw === null || raw === "" || raw === "all") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function num(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function localUserId(request: Request): string | null {
  return (request as AdminRequest).adminUser?.id ?? null;
}

// ───────────────────────── Dashboard ─────────────────────────

router.get("/dashboard/summary", async (request, response): Promise<void> => {
  const companyId = parseCompanyId(request);
  try {
    const [
      orderResult,
      freightResult,
      stockResult,
      lowStockResult,
      freightStatusResult,
      salesResult,
      trendResult,
      companyResult,
    ] = await Promise.all([
      pool.query(
        `select count(*)::int as total_orders,
                coalesce(sum(coalesce(total_amount, grand_total, total, 0)), 0)::numeric as total_revenue
           from public.orders
          where ($1::int is null or company_id = $1)`,
        [companyId],
      ),
      pool.query(
        `select count(*)::int as total_shipments
           from public.freight_shipments
          where ($1::int is null or company_id = $1)`,
        [companyId],
      ),
      pool.query(
        `select coalesce(sum(coalesce(cost_price,0) * coalesce(quantity,0)),0)::numeric as total_stock_value
           from public.stocks
          where ($1::int is null or company_id = $1)`,
        [companyId],
      ),
      pool.query(
        `select count(*)::int as low_stock_count
           from public.products
          where coalesce(stock,0) < 10
            and ($1::int is null or company_id = $1)`,
        [companyId],
      ),
      pool.query(
        `select
            count(*) filter (where lower(status::text) not in ('cancelled','completed'))::int as active_freight_count,
            count(*) filter (where lower(status::text) = 'rfq_sent')::int as awaiting_quote_count,
            count(*) filter (where lower(status::text) = 'in_transit')::int as in_transit_count
           from public.freight_shipments
          where ($1::int is null or company_id = $1)`,
        [companyId],
      ),
      pool.query(
        `select
            coalesce(sum(grand_total) filter (
              where kind::text = 'order' and status::text in ('confirmed','done')
                and created_at >= date_trunc('month', now())
            ),0)::numeric as revenue_this_month,
            coalesce(sum(grand_total) filter (
              where kind::text = 'order' and status::text in ('confirmed','done')
                and created_at >= date_trunc('month', now()) - interval '1 month'
                and created_at < date_trunc('month', now())
            ),0)::numeric as revenue_prev_month,
            count(*) filter (
              where kind::text = 'order' and status::text in ('confirmed','done')
                and created_at >= date_trunc('month', now())
            )::int as orders_this_month,
            count(*) filter (
              where kind::text = 'order' and status::text in ('confirmed','done')
                and created_at >= date_trunc('month', now()) - interval '1 month'
                and created_at < date_trunc('month', now())
            )::int as orders_prev_month,
            count(*) filter (where kind::text = 'quote' and status::text in ('draft','sent'))::int as quotes_active,
            count(*) filter (where kind::text = 'order' and status::text = 'confirmed')::int as orders_confirmed
           from public.sales_documents
          where ($1::int is null or company_id = $1 or company_id is null)`,
        [companyId],
      ),
      pool.query(
        `select to_char(date_trunc('month', created_at), 'YYYY-MM') as month,
                coalesce(sum(grand_total),0)::numeric as revenue
           from public.sales_documents
          where kind::text = 'order'
            and status::text in ('confirmed','done')
            and created_at >= date_trunc('month', now()) - interval '5 months'
            and ($1::int is null or company_id = $1 or company_id is null)
          group by date_trunc('month', created_at)
          order by date_trunc('month', created_at)`,
        [companyId],
      ),
      pool.query(
        `select c.id as company_id,
                coalesce(c.company_name, c.name, '') as company_name,
                coalesce(c.company_code, c.code, '') as company_code,
                coalesce(sum(sd.grand_total) filter (
                  where sd.kind::text='order' and sd.status::text in ('confirmed','done')
                    and sd.created_at >= date_trunc('month', now())
                ),0)::numeric as revenue_this_month,
                coalesce(sum(sd.grand_total) filter (
                  where sd.kind::text='order' and sd.status::text in ('confirmed','done')
                    and sd.created_at >= date_trunc('month', now()) - interval '1 month'
                    and sd.created_at < date_trunc('month', now())
                ),0)::numeric as revenue_prev_month,
                count(sd.id) filter (
                  where sd.kind::text='order' and sd.status::text in ('confirmed','done')
                    and sd.created_at >= date_trunc('month', now())
                )::int as orders_this_month,
                coalesce(sum(sd.grand_total) filter (
                  where sd.kind::text='order' and sd.status::text in ('confirmed','done')
                ),0)::numeric as total_revenue
           from public.companies c
           left join public.sales_documents sd on sd.company_id = c.id
          where coalesce(c.is_active,true) = true
            and ($1::int is null or c.id = $1)
          group by c.id, c.company_name, c.name, c.company_code, c.code
          order by revenue_this_month desc nulls last`,
        [companyId],
      ),
    ]);

    const orders = orderResult.rows[0] ?? {};
    const freight = freightResult.rows[0] ?? {};
    const stock = stockResult.rows[0] ?? {};
    const lowStock = lowStockResult.rows[0] ?? {};
    const freightStatus = freightStatusResult.rows[0] ?? {};
    const sales = salesResult.rows[0] ?? {};

    const companyBreakdownBase = companyResult.rows.map((row: Record<string, unknown>) => ({
      companyId: num(row.company_id),
      companyName: str(row.company_name),
      companyCode: str(row.company_code),
      revenueThisMonth: num(row.revenue_this_month),
      revenuePrevMonth: num(row.revenue_prev_month),
      ordersThisMonth: num(row.orders_this_month),
      totalRevenue: num(row.total_revenue),
    }));
    const totalThisMonth = companyBreakdownBase.reduce((sum, row) => sum + row.revenueThisMonth, 0);
    const companyBreakdown = companyBreakdownBase.map((row) => ({
      ...row,
      contributionPct: totalThisMonth > 0 ? Math.round((row.revenueThisMonth / totalThisMonth) * 100) : 0,
    }));

    response.json({
      isConsolidated: companyId === null,
      scopeCompanyId: companyId,
      companyId,
      consolidated: companyId === null,
      ordersThisMonth: num(sales.orders_this_month),
      contribution: companyBreakdown[0]?.contributionPct ?? 0,
      totalOrders: num(orders.total_orders),
      totalRevenue: num(orders.total_revenue),
      totalShipments: num(freight.total_shipments),
      totalStockValue: num(stock.total_stock_value),
      lowStockCount: num(lowStock.low_stock_count),
      activeFreightCount: num(freightStatus.active_freight_count),
      awaitingQuoteCount: num(freightStatus.awaiting_quote_count),
      inTransitCount: num(freightStatus.in_transit_count),
      salesRevenueThisMonth: num(sales.revenue_this_month),
      salesRevenuePrevMonth: num(sales.revenue_prev_month),
      salesOrdersThisMonth: num(sales.orders_this_month),
      salesOrdersPrevMonth: num(sales.orders_prev_month),
      quotesActive: num(sales.quotes_active),
      salesOrdersConfirmed: num(sales.orders_confirmed),
      monthlyRevenueTrend: trendResult.rows.map((row: Record<string, unknown>) => ({
        month: str(row.month),
        revenue: num(row.revenue),
      })),
      companyBreakdown,
      perCompany: companyBreakdown.map((row) => ({
        ...row,
        contribution: row.contributionPct,
      })),
    });
  } catch (error) {
    request.log.error({ error, companyId }, "Standalone dashboard summary failed");
    response.status(503).json({ error: "Dashboard summary unavailable." });
  }
});

router.get("/dashboard/response-times", async (request, response): Promise<void> => {
  const pathFilter = typeof request.query.path === "string" ? request.query.path.trim() : "";
  try {
    const result = await pool.query(
      `select timestamp, path, duration_ms
         from public.api_response_times
        where ($1::text = '' or path ilike '%' || $1 || '%')
        order by timestamp desc
        limit 100`,
      [pathFilter],
    );
    response.json({
      entries: result.rows.map((row: Record<string, unknown>) => ({
        timestamp: iso(row.timestamp),
        path: str(row.path),
        durationMs: num(row.duration_ms),
      })),
    });
  } catch (error) {
    request.log.warn({ error }, "Response-time history unavailable");
    response.json({ entries: [] });
  }
});

router.get("/dashboard/response-time-stats", async (request, response): Promise<void> => {
  const allowedWindows: Record<string, string> = {
    "24h": "24 hours",
    "7d": "7 days",
    "30d": "30 days",
  };
  const windowKey = typeof request.query.window === "string" ? request.query.window : "24h";
  const interval = allowedWindows[windowKey];
  if (!interval) {
    response.status(400).json({ error: "Invalid window. Allowed: 24h, 7d, 30d" });
    return;
  }
  const pathFilter = typeof request.query.path === "string" ? request.query.path.trim() : "";
  try {
    const result = await pool.query(
      `select path,
              count(*)::int as count,
              min(duration_ms)::int as min_ms,
              max(duration_ms)::int as max_ms,
              round(avg(duration_ms))::int as avg_ms,
              percentile_cont(0.95) within group (order by duration_ms)::numeric as p95_ms
         from public.api_response_times
        where timestamp >= now() - $1::interval
          and ($2::text = '' or path ilike '%' || $2 || '%')
        group by path
        order by count desc`,
      [interval, pathFilter],
    );
    response.json({
      stats: result.rows.map((row: Record<string, unknown>) => ({
        path: str(row.path),
        count: num(row.count),
        minMs: num(row.min_ms),
        maxMs: num(row.max_ms),
        avgMs: num(row.avg_ms),
        p95Ms: Math.round(num(row.p95_ms)),
      })),
    });
  } catch (error) {
    request.log.warn({ error }, "Response-time stats unavailable");
    response.json({ stats: [] });
  }
});

// ───────────────────────── Logistics orders ─────────────────────────

router.get("/logistic/orders", async (request, response): Promise<void> => {
  const status = typeof request.query.status === "string" ? request.query.status.trim() : "";
  const shipmentType = typeof request.query.shipmentType === "string" ? request.query.shipmentType.trim() : "";
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const companyId = parseCompanyId(request);

  try {
    const result = await pool.query(
      `select lo.*, s.name as approved_vendor_name
         from public.logistic_orders lo
         left join public.suppliers s on s.id = lo.approved_vendor_id
        where ($1::text = '' or lo.status = $1)
          and ($2::text = '' or lo.shipment_type = $2)
          and ($3::text = '' or lo.order_number ilike '%' || $3 || '%'
               or lo.customer_name ilike '%' || $3 || '%'
               or coalesce(lo.company_name,'') ilike '%' || $3 || '%')
          and ($4::int is null or lo.company_id = $4 or lo.company_id is null)
        order by lo.created_at desc
        limit 500`,
      [status, shipmentType, search, companyId],
    );

    response.json(result.rows.map((row: Record<string, unknown>) => ({
      id: num(row.id),
      orderNumber: str(row.order_number),
      companyName: str(row.company_name),
      customerName: str(row.customer_name),
      email: str(row.email),
      phone: str(row.phone),
      shipmentType: str(row.shipment_type),
      origin: str(row.origin),
      destination: str(row.destination),
      commodity: nullableString(row.commodity),
      cargoDescription: nullableString(row.cargo_description),
      grossWeight: row.gross_weight == null ? null : num(row.gross_weight),
      volumeCbm: row.volume_cbm == null ? null : num(row.volume_cbm),
      jumlahKoli: row.jumlah_koli == null ? null : num(row.jumlah_koli),
      requiredDate: nullableString(row.required_date),
      notes: nullableString(row.notes),
      paymentType: nullableString(row.payment_type),
      paymentMethod: nullableString(row.payment_method),
      namaPenerima: nullableString(row.nama_penerima),
      nomorPenerima: nullableString(row.nomor_penerima),
      jamOrder: nullableString(row.jam_order),
      source: str(row.source),
      aiSessionToken: nullableString(row.ai_session_token),
      subtotal: num(row.subtotal),
      tax: num(row.tax),
      grandTotal: num(row.grand_total),
      status: str(row.status),
      approvedQuoteId: row.approved_quote_id == null ? null : num(row.approved_quote_id),
      adminApprovalStatus: nullableString(row.admin_approval_status),
      approvedAt: row.approved_at == null ? null : iso(row.approved_at),
      approvedVendorId: row.approved_vendor_id == null ? null : num(row.approved_vendor_id),
      approvedVendorName: nullableString(row.approved_vendor_name),
      finalSellingPrice: row.final_selling_price == null ? null : num(row.final_selling_price),
      quotationSentAt: row.quotation_sent_at == null ? null : iso(row.quotation_sent_at),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at ?? row.created_at),
    })));
  } catch (error) {
    request.log.error({ error }, "Standalone logistic orders list failed");
    response.status(503).json({ error: "Logistic orders unavailable." });
  }
});

// ───────────────────────── Drivers ─────────────────────────

router.get("/drivers", async (request, response): Promise<void> => {
  try {
    const result = await pool.query(
      `select id, name, email, phone, license_number, vehicle_plate, vehicle_type,
              is_active, current_lat, current_lng, last_location_at, created_at,
              company_id, driver_type
         from public.drivers
        order by created_at desc`,
    );
    response.json(result.rows.map((row: Record<string, unknown>) => ({
      id: num(row.id),
      name: str(row.name),
      email: str(row.email),
      phone: nullableString(row.phone),
      licenseNumber: nullableString(row.license_number),
      vehiclePlate: nullableString(row.vehicle_plate),
      vehicleType: nullableString(row.vehicle_type),
      isActive: Boolean(row.is_active),
      currentLat: row.current_lat == null ? null : num(row.current_lat),
      currentLng: row.current_lng == null ? null : num(row.current_lng),
      lastLocationAt: row.last_location_at == null ? null : iso(row.last_location_at),
      createdAt: iso(row.created_at),
      companyId: row.company_id == null ? null : num(row.company_id),
      driverType: nullableString(row.driver_type),
    })));
  } catch (error) {
    request.log.error({ error }, "Standalone drivers list failed");
    response.status(503).json({ error: "Drivers unavailable." });
  }
});

router.get("/drivers/jobs/list", async (request, response): Promise<void> => {
  const driverId = request.query.driverId ? Number(request.query.driverId) : null;
  const shipmentId = request.query.shipmentId ? Number(request.query.shipmentId) : null;
  const logisticOrderId = request.query.logisticOrderId ? Number(request.query.logisticOrderId) : null;
  try {
    const result = await pool.query(
      `select *
         from public.driver_jobs
        where ($1::int is null or driver_id = $1)
          and ($2::int is null or freight_shipment_id = $2)
          and ($3::int is null or logistic_order_id = $3)
        order by created_at desc
        limit 500`,
      [
        Number.isSafeInteger(driverId) && Number(driverId) > 0 ? driverId : null,
        Number.isSafeInteger(shipmentId) && Number(shipmentId) > 0 ? shipmentId : null,
        Number.isSafeInteger(logisticOrderId) && Number(logisticOrderId) > 0 ? logisticOrderId : null,
      ],
    );
    response.json(result.rows.map((row: Record<string, unknown>) => ({
      id: num(row.id),
      driverId: row.driver_id == null ? null : num(row.driver_id),
      freightShipmentId: row.freight_shipment_id == null ? null : num(row.freight_shipment_id),
      logisticOrderId: row.logistic_order_id == null ? null : num(row.logistic_order_id),
      jobNumber: str(row.job_number),
      customerName: nullableString(row.customer_name),
      pickupAddress: nullableString(row.pickup_address),
      deliveryAddress: nullableString(row.delivery_address),
      cargoDescription: nullableString(row.cargo_description),
      vehicleType: nullableString(row.vehicle_type),
      truckPlate: nullableString(row.truck_plate),
      pickupDateTime: row.pickup_date_time == null ? null : iso(row.pickup_date_time),
      deliveryDateTime: row.delivery_date_time == null ? null : iso(row.delivery_date_time),
      specialInstruction: nullableString(row.special_instruction),
      weight: nullableString(row.weight),
      distance: nullableString(row.distance),
      status: str(row.status),
      notes: nullableString(row.notes),
      assignedAt: iso(row.assigned_at),
      completedAt: row.completed_at == null ? null : iso(row.completed_at),
      createdAt: iso(row.created_at),
      driverType: nullableString(row.driver_type),
      executionMode: nullableString(row.execution_mode),
      driverNameOverride: nullableString(row.driver_name_override),
      driverPhoneOverride: nullableString(row.driver_phone_override),
      vehiclePlateOverride: nullableString(row.vehicle_plate_override),
      vendorId: row.vendor_id == null ? null : num(row.vendor_id),
      companyId: row.company_id == null ? null : num(row.company_id),
    })));
  } catch (error) {
    request.log.error({ error }, "Standalone driver jobs list failed");
    response.status(503).json({ error: "Driver jobs unavailable." });
  }
});

// The previous full backend kept geofence alert state in process memory.
// The standalone runtime must not fabricate persisted alerts after a restart.
router.get("/drivers/geofence-alerts", (_request, response) => {
  response.json([]);
});

// ───────────────────────── Notifications ─────────────────────────

router.get("/notifications", async (request, response): Promise<void> => {
  const type = typeof request.query.type === "string" ? request.query.type : "all";
  const read = typeof request.query.read === "string" ? request.query.read : "all";
  const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
  const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(request.query.offset ?? 0) || 0, 0);
  try {
    const result = await pool.query(
      `select *
         from public.admin_notifications
        where ($1::text = 'all' or type = $1)
          and ($2::text = 'all'
               or ($2 = 'unread' and read_at is null)
               or ($2 = 'read' and read_at is not null))
          and ($3::text = '' or coalesce(order_number,'') ilike '%' || $3 || '%'
               or coalesce(customer_name,'') ilike '%' || $3 || '%')
        order by created_at desc
        limit $4 offset $5`,
      [type, read, search, limit, offset],
    );
    const totals = await pool.query(
      `select count(*)::int as total,
              count(*) filter (where read_at is null)::int as unread_total
         from public.admin_notifications
        where ($1::text = 'all' or type = $1)
          and ($2::text = 'all'
               or ($2 = 'unread' and read_at is null)
               or ($2 = 'read' and read_at is not null))
          and ($3::text = '' or coalesce(order_number,'') ilike '%' || $3 || '%'
               or coalesce(customer_name,'') ilike '%' || $3 || '%')`,
      [type, read, search],
    );
    response.json({
      data: result.rows,
      total: num(totals.rows[0]?.total),
      unreadTotal: num(totals.rows[0]?.unread_total),
    });
  } catch (error) {
    request.log.error({ error }, "Standalone notifications list failed");
    response.status(503).json({ error: "Notifications unavailable." });
  }
});

router.get("/notifications/unread-count", async (request, response): Promise<void> => {
  try {
    const result = await pool.query(
      "select count(*)::int as count from public.admin_notifications where read_at is null",
    );
    response.json({ count: num(result.rows[0]?.count) });
  } catch (error) {
    request.log.error({ error }, "Standalone notification count failed");
    response.status(503).json({ error: "Notifications unavailable." });
  }
});

router.post("/notifications/mark-all-read", async (request, response): Promise<void> => {
  try {
    await pool.query("update public.admin_notifications set read_at = now() where read_at is null");
    response.json({ ok: true });
  } catch (error) {
    request.log.error({ error }, "Standalone mark notifications read failed");
    response.status(503).json({ error: "Notifications unavailable." });
  }
});

router.post("/notifications/:id/read", async (request, response): Promise<void> => {
  const id = Number(request.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    response.status(400).json({ error: "Invalid notification id." });
    return;
  }
  try {
    await pool.query(
      "update public.admin_notifications set read_at = now() where id = $1 and read_at is null",
      [id],
    );
    response.json({ ok: true });
  } catch (error) {
    request.log.error({ error, id }, "Standalone notification read failed");
    response.status(503).json({ error: "Notifications unavailable." });
  }
});

// ───────────────────────── Navigation preferences ─────────────────────────

router.get("/nav-preferences", async (request, response): Promise<void> => {
  const userId = localUserId(request);
  if (!userId) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const result = await pool.query(
      `select hidden_items, item_order, child_order
         from public.user_nav_preferences
        where user_id = $1
        limit 1`,
      [userId],
    );
    const row = result.rows[0];
    response.json({
      hiddenItems: Array.isArray(row?.hidden_items) ? row.hidden_items : [],
      itemOrder: Array.isArray(row?.item_order) ? row.item_order : [],
      childOrder: row?.child_order && typeof row.child_order === "object" ? row.child_order : {},
    });
  } catch (error) {
    request.log.error({ error }, "Standalone nav preferences failed");
    response.status(503).json({ error: "Navigation preferences unavailable." });
  }
});

router.put("/nav-preferences", async (request, response): Promise<void> => {
  const userId = localUserId(request);
  if (!userId) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }
  const hiddenItems = Array.isArray(request.body?.hiddenItems)
    ? request.body.hiddenItems.filter((value: unknown): value is string => typeof value === "string")
    : [];
  const itemOrder = Array.isArray(request.body?.itemOrder)
    ? request.body.itemOrder.filter((value: unknown): value is string => typeof value === "string")
    : [];
  const childOrder = request.body?.childOrder && typeof request.body.childOrder === "object" && !Array.isArray(request.body.childOrder)
    ? request.body.childOrder
    : {};
  try {
    await pool.query(
      `insert into public.user_nav_preferences (user_id, hidden_items, item_order, child_order, updated_at)
       values ($1, $2::text[], $3::text[], $4::jsonb, now())
       on conflict (user_id) do update
       set hidden_items = excluded.hidden_items,
           item_order = excluded.item_order,
           child_order = excluded.child_order,
           updated_at = now()`,
      [userId, hiddenItems, itemOrder, JSON.stringify(childOrder)],
    );
    response.json({ ok: true });
  } catch (error) {
    request.log.error({ error }, "Standalone nav preferences update failed");
    response.status(503).json({ error: "Navigation preferences unavailable." });
  }
});

router.get("/settings/nav-company-config", async (request, response): Promise<void> => {
  try {
    const result = await pool.query(
      "select value from public.portal_content where key = 'nav_company_config' order by updated_at desc limit 1",
    );
    const raw = result.rows[0]?.value;
    if (typeof raw !== "string" || !raw.trim()) {
      response.json({});
      return;
    }
    try {
      response.json(JSON.parse(raw));
    } catch {
      response.json({});
    }
  } catch (error) {
    request.log.error({ error }, "Standalone nav company config failed");
    response.status(503).json({ error: "Navigation company config unavailable." });
  }
});

router.put("/settings/nav-company-config", async (request, response): Promise<void> => {
  const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
    ? request.body
    : {};
  try {
    await pool.query(
      `insert into public.portal_content (key, value, updated_at)
       values ('nav_company_config', $1, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(body)],
    );
    response.json({ ok: true });
  } catch (error) {
    request.log.error({ error }, "Standalone nav company config update failed");
    response.status(503).json({ error: "Navigation company config unavailable." });
  }
});

// ───────────────────────── Tenant dashboard ─────────────────────────

router.get("/tenant/dashboard", async (request, response): Promise<void> => {
  const companyId = parseCompanyId(request);
  if (!companyId || !new Set([1, 4]).has(companyId)) {
    response.status(403).json({ error: "Tenant module is not available for this company." });
    return;
  }
  try {
    const [tenants, bookings, payments, pending, units, invoices] = await Promise.all([
      pool.query(
        "select count(*)::int as total, count(*) filter (where status='active')::int as active from public.tenants where company_id=$1",
        [companyId],
      ),
      pool.query(
        "select count(*)::int as total, count(*) filter (where payment_status='unpaid')::int as unpaid from public.tenant_bookings where company_id=$1",
        [companyId],
      ),
      pool.query(
        "select coalesce(sum(amount),0)::numeric as revenue from public.tenant_payments where status='confirmed' and company_id=$1",
        [companyId],
      ),
      pool.query(
        "select count(*)::int as pending from public.tenant_payments where status='pending' and company_id=$1",
        [companyId],
      ),
      pool.query(
        `select count(*)::int as total,
                count(*) filter (where status='available')::int as available,
                count(*) filter (where status='occupied')::int as occupied,
                count(*) filter (where status='maintenance')::int as maintenance
           from public.tenant_units where company_id=$1`,
        [companyId],
      ),
      pool.query(
        `select count(*)::int as total,
                count(*) filter (where status='paid')::int as paid,
                count(*) filter (where status in ('unpaid','partial','sent'))::int as unpaid_count,
                count(*) filter (where status='overdue' or (due_date < current_date and status not in ('paid','cancelled')))::int as overdue,
                coalesce(sum(outstanding_amount) filter (where status not in ('paid','cancelled')),0)::numeric as total_outstanding,
                coalesce(sum(paid_amount) filter (where paid_at >= date_trunc('month',now())),0)::numeric as paid_this_month
           from public.tenant_invoices where company_id=$1`,
        [companyId],
      ),
    ]);
    const invoice = invoices.rows[0] ?? {};
    response.json({
      tenants: tenants.rows[0] ?? { total: 0, active: 0 },
      bookings: bookings.rows[0] ?? { total: 0, unpaid: 0 },
      revenue: num(payments.rows[0]?.revenue),
      pendingPayments: num(pending.rows[0]?.pending),
      units: units.rows[0] ?? { total: 0, available: 0, occupied: 0, maintenance: 0 },
      invoices: {
        total: num(invoice.total),
        paid: num(invoice.paid),
        unpaid_count: num(invoice.unpaid_count),
        overdue: num(invoice.overdue),
        total_outstanding: num(invoice.total_outstanding),
        paid_this_month: num(invoice.paid_this_month),
        pending: num(invoice.unpaid_count),
        piutang: num(invoice.total_outstanding),
      },
    });
  } catch (error) {
    request.log.error({ error, companyId }, "Standalone tenant dashboard failed");
    response.status(503).json({ error: "Tenant dashboard unavailable." });
  }
});

// ───────────────────────── Customer Portal workload badge/list ─────────────────────────

router.get("/portal/admin/service-operations", async (request, response): Promise<void> => {
  const limit = Math.min(Math.max(Number(request.query.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(request.query.offset ?? 0) || 0, 0);
  try {
    const dataResult = await pool.query(
      `with workload as (
         select
           'logistic-order'::text as service_key,
           'Logistics / Customer Order'::text as service_label,
           id,
           order_number::text as reference,
           status::text,
           customer_name::text,
           coalesce(company_name,'')::text as customer_company,
           phone::text as customer_phone,
           created_at,
           updated_at,
           ('/logistics/orders/' || id)::text as management_path,
           status::text in (
             'Order Received','Admin Review','Product RFQ Sent','Product Quote Received',
             'Product Vendor Selected','Customer Product Approval','Shipment Selection Pending',
             'Ready for Pickup','RFQ Sent','Quote Received','Customer Approval','Vendor Confirmed',
             'In Progress','Pickup','In Transit','Arrived','Delivered','POD Uploaded',
             'Invoice Issued','Payment Received'
           ) as is_pending,
           status::text in (
             'Order Received','Admin Review','Product RFQ Sent','Product Quote Received',
             'Product Vendor Selected','Customer Product Approval','Shipment Selection Pending',
             'Ready for Pickup','RFQ Sent','Quote Received','Customer Approval','Vendor Confirmed',
             'In Progress','Pickup','In Transit','Arrived','Delivered','POD Uploaded',
             'Invoice Issued','Payment Received','Completed','Cancelled'
           ) as status_known
         from public.logistic_orders
         where source in ('customer_portal','portal')

         union all

         select
           'service-request'::text,
           'Pabean / Custom Clearance / Layanan'::text,
           id,
           request_number::text,
           status::text,
           customer_name::text,
           coalesce(customer_company,'')::text,
           customer_phone::text,
           created_at,
           coalesce(updated_at,created_at),
           ('/logistics/service-requests/' || id)::text,
           status::text in ('submitted','pending_review','need_review','need_more_data','waiting_rate','reviewing','quoted','approved_for_rfq'),
           status::text in ('draft','submitted','pending_review','need_review','need_more_data','waiting_rate','reviewing','quoted','approved_for_rfq','approved','booked','completed','rejected','cancelled','quote_declined')
         from public.customer_service_requests
         where status <> 'draft'
       )
       select *
       from workload
       order by created_at desc
       limit $1 offset $2`,
      [limit, offset],
    );
    const summaryResult = await pool.query(
      `with workload as (
         select 'logistic-order'::text as service_key,
                'Logistics / Customer Order'::text as service_label,
                status::text in (
                  'Order Received','Admin Review','Product RFQ Sent','Product Quote Received',
                  'Product Vendor Selected','Customer Product Approval','Shipment Selection Pending',
                  'Ready for Pickup','RFQ Sent','Quote Received','Customer Approval','Vendor Confirmed',
                  'In Progress','Pickup','In Transit','Arrived','Delivered','POD Uploaded',
                  'Invoice Issued','Payment Received'
                ) as is_pending,
                status::text in (
                  'Order Received','Admin Review','Product RFQ Sent','Product Quote Received',
                  'Product Vendor Selected','Customer Product Approval','Shipment Selection Pending',
                  'Ready for Pickup','RFQ Sent','Quote Received','Customer Approval','Vendor Confirmed',
                  'In Progress','Pickup','In Transit','Arrived','Delivered','POD Uploaded',
                  'Invoice Issued','Payment Received','Completed','Cancelled'
                ) as status_known
         from public.logistic_orders where source in ('customer_portal','portal')
         union all
         select 'service-request'::text,
                'Pabean / Custom Clearance / Layanan'::text,
                status::text in ('submitted','pending_review','need_review','need_more_data','waiting_rate','reviewing','quoted','approved_for_rfq'),
                status::text in ('draft','submitted','pending_review','need_review','need_more_data','waiting_rate','reviewing','quoted','approved_for_rfq','approved','booked','completed','rejected','cancelled','quote_declined')
         from public.customer_service_requests where status <> 'draft'
       )
       select service_key, service_label, count(*)::int as total,
              count(*) filter (where is_pending)::int as pending,
              count(*) filter (where not status_known)::int as ambiguous
       from workload
       group by service_key, service_label
       order by service_label`,
    );
    const total = summaryResult.rows.reduce((sum: number, row: Record<string, unknown>) => sum + num(row.total), 0);
    response.json({
      data: dataResult.rows.map((row: Record<string, unknown>) => ({
        ...row,
        available_actions: [],
      })),
      total,
      summary: summaryResult.rows,
    });
  } catch (error) {
    request.log.error({ error }, "Standalone Customer Portal workload failed");
    response.status(503).json({ error: "Customer Portal workload unavailable." });
  }
});

export default router;
