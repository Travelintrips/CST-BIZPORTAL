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

type AccountingRequest = Request & {
  accountingUser?: DevAuthUser;
};

router.use(async (req, res, next) => {
  try {
    const user = isDevelopmentEnvironment()
      ? getDevSession(req)
      : (() => {
          const session = getProductionSession(req);
          return session ? getProductionUser(session) : Promise.resolve(null);
        })();
    const resolvedUser = await user;
    const role = resolvedUser?.role.toLowerCase();

    if (!resolvedUser) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!role || !["admin", "owner", "finance", "accounting"].includes(role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    (req as AccountingRequest).accountingUser = resolvedUser;
    next();
  } catch (error) {
    req.log.error({ error }, "Failed to authenticate accounting request");
    res.status(503).json({ error: "Authorization service unavailable" });
  }
});

router.use(async (req, res, next) => {
  try {
    const session = isDevelopmentEnvironment() ? null : getProductionSession(req);
    const user = isDevelopmentEnvironment()
      ? getDevSession(req)
      : session ? await getProductionUser(session) : null;
    if (!user || !["admin", "owner", "finance", "accounting"].includes(user.role)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  } catch (error) {
    req.log.error({ error }, "Accounting authorization failed");
    res.status(503).json({ error: "Authorization service unavailable." });
  }
});

type QueryValue = string | number;

interface PostingErrorRow {
  id: number;
  company_id: number | null;
  branch_id: number | null;
  source_module: string | null;
  source_table: string | null;
  source_id: number | null;
  source_ref: string | null;
  error_code: string | null;
  error_message: string;
  payload: unknown;
  resolved_at: Date | null;
  resolved_by: string | null;
  resolve_note: string | null;
  created_at: Date;
}

interface PostingErrorUpdateRow {
  id: number;
  resolved_at: Date;
  resolved_by: string | null;
  resolve_note: string | null;
}

interface TrialBalanceRow {
  account_id: number;
  code: string;
  name: string;
  type: string;
  parent_id: number | null;
  is_header: boolean;
  is_postable: boolean;
  company_id: number;
  branch_id: number | null;
  division_id: number | null;
  company_name: string | null;
  company_code: string | null;
  total_debit: string;
  total_credit: string;
  balance: string;
  counterparty_companies: string | null;
}

function first(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function requestedCompanyId(req: Request): number | null {
  const raw = first(req.query.company) ?? first(req.query.companyId) ?? first(req.query.company_id);
  const sessionCompanyId = (req as AccountingRequest).accountingUser?.companyId ?? null;
  if (!raw || raw === "all") return sessionCompanyId;
  const companyId = Number(raw);
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error("INVALID_COMPANY");
  if (sessionCompanyId !== null && sessionCompanyId !== companyId) throw new Error("INVALID_COMPANY");
  return companyId;
}

function companyFilter(req: Request, values: QueryValue[], column = "gl.company_id"): string {
  const companyId = requestedCompanyId(req);
  if (companyId === null) return "";
  values.push(companyId);
  return ` and ${column} = $${values.length}`;
}

function dateFilter(req: Request, values: QueryValue[], column = "gl.date"): string {
  let sql = "";
  const from = first(req.query.from) ?? first(req.query.startDate) ?? first(req.query.date_from);
  const to = first(req.query.to) ?? first(req.query.endDate) ?? first(req.query.date_to);
  if (from) {
    values.push(from);
    sql += ` and ${column} >= $${values.length}::timestamptz`;
  }
  if (to) {
    values.push(to);
    sql += ` and ${column} <= $${values.length}::timestamptz`;
  }
  return sql;
}

function branchFilter(req: Request, values: QueryValue[], column = "gl.branch_id"): string {
  const raw = first(req.query.branch_id);
  if (!raw) return "";
  const branchId = Number(raw);
  if (!Number.isInteger(branchId) || branchId <= 0) throw new Error("INVALID_FILTER");
  values.push(branchId);
  return ` and ${column} = $${values.length}`;
}

function costCenterFilter(req: Request, values: QueryValue[], column = "e.cost_center_id"): string {
  const raw = first(req.query.cost_center_id);
  if (!raw) return "";
  const costCenterId = Number(raw);
  if (!Number.isInteger(costCenterId) || costCenterId <= 0) throw new Error("INVALID_FILTER");
  values.push(costCenterId);
  return ` and ${column} = $${values.length}`;
}

function numberValue(value: string | number | null): number {
  return Number(value ?? 0);
}

const ACCOUNTING_SETTING_FIELDS = [
  ["arAccountId", "ar_account_id", "number"],
  ["apAccountId", "ap_account_id", "number"],
  ["salesIncomeAccountId", "sales_income_account_id", "number"],
  ["purchaseExpenseAccountId", "purchase_expense_account_id", "number"],
  ["defaultBankAccountId", "default_bank_account_id", "number"],
  ["defaultCashAccountId", "default_cash_account_id", "number"],
  ["qrisAccountId", "qris_account_id", "number"],
  ["ppnOutputAccountId", "ppn_output_account_id", "number"],
  ["ppnInputAccountId", "ppn_input_account_id", "number"],
  ["salesJournalId", "sales_journal_id", "number"],
  ["purchaseJournalId", "purchase_journal_id", "number"],
  ["bankJournalId", "bank_journal_id", "number"],
  ["qrisJournalId", "qris_journal_id", "number"],
  ["cashJournalId", "cash_journal_id", "number"],
  ["defaultSalesTaxId", "default_sales_tax_id", "number"],
  ["defaultPurchaseTaxId", "default_purchase_tax_id", "number"],
  ["inventoryAccountId", "inventory_account_id", "number"],
  ["cogsAccountId", "cogs_account_id", "number"],
  ["companyName", "company_name", "string"],
  ["companyAddress", "company_address", "string"],
  ["companyNpwp", "company_npwp", "string"],
  ["companyLogoUrl", "company_logo_url", "string"],
] as const;

type AccountingSettingField = (typeof ACCOUNTING_SETTING_FIELDS)[number];

interface AccountingSettingsRow {
  id: number;
  ar_account_id: number | null;
  ap_account_id: number | null;
  sales_income_account_id: number | null;
  purchase_expense_account_id: number | null;
  default_bank_account_id: number | null;
  default_cash_account_id: number | null;
  qris_account_id: number | null;
  ppn_output_account_id: number | null;
  ppn_input_account_id: number | null;
  sales_journal_id: number | null;
  purchase_journal_id: number | null;
  bank_journal_id: number | null;
  qris_journal_id: number | null;
  cash_journal_id: number | null;
  default_sales_tax_id: number | null;
  default_purchase_tax_id: number | null;
  inventory_account_id: number | null;
  cogs_account_id: number | null;
  company_name: string | null;
  company_address: string | null;
  company_npwp: string | null;
  company_logo_url: string | null;
  updated_at: Date | string;
}

function serializeAccountingSettings(row: AccountingSettingsRow) {
  return {
    id: Number(row.id),
    arAccountId: row.ar_account_id,
    apAccountId: row.ap_account_id,
    salesIncomeAccountId: row.sales_income_account_id,
    purchaseExpenseAccountId: row.purchase_expense_account_id,
    defaultBankAccountId: row.default_bank_account_id,
    defaultCashAccountId: row.default_cash_account_id,
    qrisAccountId: row.qris_account_id,
    ppnOutputAccountId: row.ppn_output_account_id,
    ppnInputAccountId: row.ppn_input_account_id,
    salesJournalId: row.sales_journal_id,
    purchaseJournalId: row.purchase_journal_id,
    bankJournalId: row.bank_journal_id,
    qrisJournalId: row.qris_journal_id,
    cashJournalId: row.cash_journal_id,
    defaultSalesTaxId: row.default_sales_tax_id,
    defaultPurchaseTaxId: row.default_purchase_tax_id,
    inventoryAccountId: row.inventory_account_id,
    cogsAccountId: row.cogs_account_id,
    companyName: row.company_name,
    companyAddress: row.company_address,
    companyNpwp: row.company_npwp,
    companyLogoUrl: row.company_logo_url,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function loadAccountingSettings(req: Request) {
  const companyId = requestedCompanyId(req);
  const result = await pool.query<AccountingSettingsRow>(`
    select
      coalesce(s.id, 0)::int as id,
      s.ar_account_id,
      s.ap_account_id,
      s.sales_income_account_id,
      s.purchase_expense_account_id,
      s.default_bank_account_id,
      s.default_cash_account_id,
      s.qris_account_id,
      s.ppn_output_account_id,
      s.ppn_input_account_id,
      s.sales_journal_id,
      s.purchase_journal_id,
      s.bank_journal_id,
      s.qris_journal_id,
      s.cash_journal_id,
      s.default_sales_tax_id,
      s.default_purchase_tax_id,
      s.inventory_account_id,
      s.cogs_account_id,
      coalesce(nullif(s.company_name, ''), c.company_name, c.name) as company_name,
      coalesce(nullif(s.company_address, ''), c.address) as company_address,
      coalesce(nullif(s.company_npwp, ''), c.npwp) as company_npwp,
      coalesce(nullif(s.company_logo_url, ''), c.logo_url) as company_logo_url,
      coalesce(s.updated_at, now()) as updated_at
    from (select $1::int as company_id) target
    left join public.accounting_settings s
      on (($1::int is null and s.company_id is null) or s.company_id = $1::int)
    left join public.companies c on c.id = $1::int
    order by s.id desc nulls last
    limit 1
  `, [companyId]);

  const row = result.rows[0];
  if (!row) {
    throw new Error("ACCOUNTING_SETTINGS_NOT_FOUND");
  }
  return serializeAccountingSettings(row);
}

function normalizeSettingValue(field: AccountingSettingField, value: unknown): number | string | null {
  if (value === null) return null;
  if (field[2] === "number") {
    if (!Number.isInteger(value) || Number(value) <= 0) {
      throw new Error(`INVALID_${field[0]}`);
    }
    return Number(value);
  }
  if (typeof value !== "string") throw new Error(`INVALID_${field[0]}`);
  return value.trim() || null;
}

router.get("/accounting/settings", async (req, res): Promise<void> => {
  try {
    res.json(await loadAccountingSettings(req));
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_COMPANY") {
      res.status(400).json({ error: "Perusahaan tidak valid" });
      return;
    }
    req.log.error({ error }, "Failed to load accounting settings from Supabase");
    res.status(503).json({ error: "Pengaturan akuntansi tidak dapat dimuat" });
  }
});

router.patch("/accounting/settings", async (req, res): Promise<void> => {
  const companyId = requestedCompanyId(req);
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  const updates: Array<{ column: string; value: number | string | null }> = [];

  try {
    for (const field of ACCOUNTING_SETTING_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body, field[0])) {
        updates.push({ column: field[1], value: normalizeSettingValue(field, body[field[0]]) });
      }
    }
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Pengaturan tidak valid" });
    return;
  }

  if (updates.length === 0) {
    try {
      res.json(await loadAccountingSettings(req));
    } catch (error) {
      req.log.error({ error }, "Failed to load accounting settings after empty update");
      res.status(503).json({ error: "Pengaturan akuntansi tidak dapat dimuat" });
    }
    return;
  }

  try {
    const existing = await pool.query<{ id: number }>(
      `select id from public.accounting_settings
       where (($1::int is null and company_id is null) or company_id = $1::int)
       order by id desc limit 1`,
      [companyId],
    );

    if (existing.rows[0]) {
      const values: Array<number | string | null> = [];
      const assignments = updates.map((update) => {
        values.push(update.value);
        return `${update.column} = $${values.length}`;
      });
      values.push(existing.rows[0].id);
      await pool.query(
        `update public.accounting_settings
            set ${assignments.join(", ")}, updated_at = now()
          where id = $${values.length}`,
        values,
      );
    } else {
      const columns = ["company_id", ...updates.map((update) => update.column)];
      const values = [companyId, ...updates.map((update) => update.value)];
      const placeholders = values.map((_, index) => `$${index + 1}`);
      await pool.query(
        `insert into public.accounting_settings (${columns.join(", ")})
         values (${placeholders.join(", ")})`,
        values,
      );
    }

    res.json(await loadAccountingSettings(req));
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_COMPANY") {
      res.status(400).json({ error: "Perusahaan tidak valid" });
      return;
    }
    req.log.error({ error }, "Failed to update accounting settings in Supabase");
    res.status(503).json({ error: "Pengaturan akuntansi tidak dapat disimpan" });
  }
});

function fiscalYearPeriod(req: Request): { from: string; to: string } {
  const to = first(req.query.to) ?? first(req.query.endDate) ?? first(req.query.date_to)
    ?? new Date().toISOString();
  const asOf = new Date(to);
  if (Number.isNaN(asOf.getTime())) throw new Error("INVALID_FILTER");
  return { from: `${asOf.getUTCFullYear()}-01-01T00:00:00.000Z`, to };
}

function reportError(req: Request, res: Parameters<Parameters<IRouter["get"]>[1]>[1], error: unknown): void {
  if (error instanceof Error && ["INVALID_COMPANY", "INVALID_FILTER"].includes(error.message)) {
    res.status(400).json({ error: "Filter laporan tidak valid" });
    return;
  }
  req.log.error({ error }, "Failed to load accounting data from Supabase");
  res.status(503).json({ error: "Data accounting tidak dapat dimuat" });
}

router.get("/accounting/accounts", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    let where = "where coalesce(a.is_active, true) = true";
    const companyId = requestedCompanyId(req);
    if (companyId !== null) {
      values.push(companyId);
      where += ` and (a.company_id = $${values.length} or a.company_id is null)`;
    }
    const result = await pool.query<{
      id: number; company_id: number | null; company_code: string | null; code: string;
      name: string; type: string; parent_id: number | null; is_active: boolean | null; created_at: Date;
    }>(`
      select a.id, a.company_id, coalesce(c.company_code, c.code) company_code,
             a.code, a.name, coalesce(a.account_type::text, a.type::text) type,
             a.parent_id, a.is_active, a.created_at
      from public.chart_of_accounts a
      left join public.companies c on c.id = a.company_id
      ${where}
      order by coalesce(c.company_code, c.code, ''), a.code, a.id
    `, values);
    res.json(result.rows.map((row) => ({
      id: row.id, companyId: row.company_id, companyCode: row.company_code,
      code: row.code, name: row.name, type: row.type,
      parentId: row.parent_id, isActive: row.is_active ?? true, createdAt: row.created_at,
    })));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/journals", async (req, res): Promise<void> => {
  try {
    const companyId = requestedCompanyId(req);
    const result = await pool.query<{
      id: number;
      code: string;
      name: string;
      type: string;
      default_debit_account_id: number | null;
      default_credit_account_id: number | null;
      is_active: boolean | null;
      created_at: Date | string;
    }>(
      `select id, code, name, type::text type,
              default_debit_account_id, default_credit_account_id,
              is_active, created_at
         from public.accounting_journals
        where coalesce(is_active, true) = true
          and ($1::int is null or company_id = $1 or company_id is null)
        order by code, id`,
      [companyId],
    );

    res.json(result.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      defaultDebitAccountId: row.default_debit_account_id,
      defaultCreditAccountId: row.default_credit_account_id,
      isActive: row.is_active ?? true,
      createdAt: new Date(row.created_at).toISOString(),
    })));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/taxes", async (req, res): Promise<void> => {
  try {
    const companyId = requestedCompanyId(req);
    const result = await pool.query<{
      id: number;
      name: string;
      rate: string | number;
      kind: string;
      account_id: number;
      is_active: boolean | null;
      created_at: Date | string;
    }>(
      `select id, name, rate, kind::text kind, account_id, is_active, created_at
         from public.accounting_taxes
        where coalesce(is_active, true) = true
          and ($1::int is null or company_id = $1)
        order by id`,
      [companyId],
    );

    res.json(result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      rate: numberValue(row.rate),
      kind: row.kind,
      accountId: row.account_id,
      isActive: row.is_active ?? true,
      createdAt: new Date(row.created_at).toISOString(),
    })));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/reports/trial-balance", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    const filters = companyFilter(req, values) + dateFilter(req, values);
    const result = await pool.query<{
      account_id: number; company_id: number | null; company_code: string | null;
      code: string; name: string; type: string; debit: string; credit: string; balance: string;
    }>(`
      select gl.account_id, gl.company_id, coalesce(c.company_code, c.code) company_code,
             gl.account_code code, gl.account_name name, gl.account_type::text type,
             sum(gl.debit) debit, sum(gl.credit) credit,
             sum(gl.debit - gl.credit) balance
      from public.accounting_general_ledger_v gl
      left join public.companies c on c.id = gl.company_id
      where gl.status::text = 'posted' ${filters}
      group by gl.account_id, gl.company_id, coalesce(c.company_code, c.code),
               gl.account_code, gl.account_name, gl.account_type
      order by company_code, code
    `, values);
    const rows = result.rows.map((row) => ({
      accountId: row.account_id, companyId: row.company_id, companyCode: row.company_code,
      code: row.code, name: row.name, type: row.type,
      debit: numberValue(row.debit), credit: numberValue(row.credit), balance: numberValue(row.balance),
    }));
    res.json({
      from: first(req.query.from) ?? null, to: first(req.query.to) ?? null, rows,
      totalDebit: rows.reduce((sum, row) => sum + row.debit, 0),
      totalCredit: rows.reduce((sum, row) => sum + row.credit, 0),
    });
  } catch (error) {
    reportError(req, res, error);
  }
});

async function loadProfitLoss(req: Request, period?: { from: string; to: string }) {
  const values: QueryValue[] = [];
  let filters = companyFilter(req, values);
  if (period) {
    values.push(period.from, period.to);
    filters += ` and gl.date >= $${values.length - 1}::timestamptz and gl.date <= $${values.length}::timestamptz`;
  } else {
    filters += dateFilter(req, values);
  }
  filters += branchFilter(req, values) + costCenterFilter(req, values);
  const result = await pool.query<{
    account_id: number; code: string; name: string; type: string; category: string | null; amount: string;
  }>(`
    select gl.account_id, gl.account_code code, gl.account_name name, gl.account_type::text type,
           max(a.account_category::text) category,
           sum(case when gl.account_type::text = 'revenue' then gl.credit - gl.debit else gl.debit - gl.credit end) amount
    from public.accounting_general_ledger_v gl
    left join public.chart_of_accounts a on a.id = gl.account_id
    left join public.accounting_entries e on e.id = gl.entry_id
    where gl.status::text = 'posted' and gl.account_type::text in ('revenue', 'expense') ${filters}
    group by gl.account_id, gl.account_code, gl.account_name, gl.account_type
    order by gl.account_code
  `, values);
  const mapped = result.rows.map((row) => ({
    accountId: row.account_id, code: row.code, name: row.name, type: row.type,
    category: row.category, amount: numberValue(row.amount),
  }));
  const revenues = mapped.filter((row) => row.type === "revenue");
  const expenseRows = mapped.filter((row) => row.type === "expense");
  const cogs = expenseRows.filter((row) =>
    row.category === "COGS" || /\b(hpp|cogs|harga pokok)\b/i.test(`${row.code} ${row.name}`));
  const cogsIds = new Set(cogs.map((row) => row.accountId));
  const operatingExpenses = expenseRows.filter((row) => !cogsIds.has(row.accountId));
  const clean = (rows: typeof mapped) => rows.map(({ accountId, code, name, amount }) => ({ accountId, code, name, amount }));
  const totalRevenue = revenues.reduce((sum, row) => sum + row.amount, 0);
  const totalCogs = cogs.reduce((sum, row) => sum + row.amount, 0);
  const totalOperatingExpense = operatingExpenses.reduce((sum, row) => sum + row.amount, 0);
  const totalExpense = totalCogs + totalOperatingExpense;
  return {
    from: first(req.query.from) ?? null, to: first(req.query.to) ?? null,
    revenues: clean(revenues), cogs: clean(cogs), operatingExpenses: clean(operatingExpenses),
    expenses: clean(expenseRows), totalRevenue, totalCogs, totalOperatingExpense, totalExpense,
    grossProfit: totalRevenue - totalCogs, netIncome: totalRevenue - totalExpense,
  };
}

router.get("/accounting/reports/profit-loss", async (req, res): Promise<void> => {
  try {
    res.json(await loadProfitLoss(req));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/reports/profit-loss-monthly", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    const filters = companyFilter(req, values) + dateFilter(req, values);
    const result = await pool.query<{
      month_key: string; revenue: string; cogs: string; operating_expense: string;
    }>(`
      select to_char(date_trunc('month', gl.date), 'YYYY-MM') as month_key,
        sum(case when gl.account_type::text = 'revenue' then gl.credit - gl.debit else 0 end) revenue,
        sum(case when gl.account_type::text = 'expense' and
          (a.account_category::text = 'COGS' or gl.account_name ~* '(HPP|COGS|Harga Pokok)')
          then gl.debit - gl.credit else 0 end) cogs,
        sum(case when gl.account_type::text = 'expense' and not
          (coalesce(a.account_category::text = 'COGS', false) or gl.account_name ~* '(HPP|COGS|Harga Pokok)')
          then gl.debit - gl.credit else 0 end) operating_expense
      from public.accounting_general_ledger_v gl
      left join public.chart_of_accounts a on a.id = gl.account_id
      where gl.status::text = 'posted' ${filters}
      group by date_trunc('month', gl.date) order by date_trunc('month', gl.date)
    `, values);
    res.json({ months: result.rows.map((row) => {
      const revenue = numberValue(row.revenue);
      const cogs = numberValue(row.cogs);
      const operatingExpense = numberValue(row.operating_expense);
      return { month: row.month_key, revenue, cogs, operatingExpense, expense: cogs + operatingExpense,
        grossProfit: revenue - cogs, netIncome: revenue - cogs - operatingExpense };
    }) });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/reports/general-ledger", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    let filters = companyFilter(req, values) + dateFilter(req, values)
      + branchFilter(req, values) + costCenterFilter(req, values);
    const accountId = first(req.query.accountId);
    if (accountId) {
      const parsed = Number(accountId);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("INVALID_COMPANY");
      values.push(parsed);
      filters += ` and gl.account_id = $${values.length}`;
    }
    const result = await pool.query<{
      account_id: number; code: string; name: string; type: string; date: Date; entry_number: string;
      ref: string | null; description: string | null; debit: string; credit: string;
    }>(`
      select gl.account_id, gl.account_code code, gl.account_name name, gl.account_type::text type,
             gl.date, gl.entry_number, gl.ref, coalesce(gl.line_description, gl.entry_description) description,
             gl.debit, gl.credit
      from public.accounting_general_ledger_v gl
      left join public.accounting_entries e on e.id = gl.entry_id
      where gl.status::text = 'posted' ${filters}
      order by gl.account_code, gl.date, gl.entry_id, gl.line_id
    `, values);
    const openingByAccount = new Map<number, number>();
    const from = first(req.query.from) ?? first(req.query.startDate);
    if (from) {
      const openingValues: QueryValue[] = [];
      let openingFilters = companyFilter(req, openingValues) + branchFilter(req, openingValues)
        + costCenterFilter(req, openingValues);
      if (accountId) {
        openingValues.push(Number(accountId));
        openingFilters += ` and gl.account_id = $${openingValues.length}`;
      }
      openingValues.push(from);
      const opening = await pool.query<{ account_id: number; balance: string }>(`
        select gl.account_id, coalesce(sum(gl.debit - gl.credit), 0)::text balance
        from public.accounting_general_ledger_v gl
        left join public.accounting_entries e on e.id = gl.entry_id
        where gl.status::text = 'posted' ${openingFilters}
          and gl.date < $${openingValues.length}::timestamptz
        group by gl.account_id
      `, openingValues);
      for (const row of opening.rows) openingByAccount.set(row.account_id, Number(row.balance));
    }
    const accounts = new Map<number, {
      accountId: number; code: string; name: string; type: string;
      rows: Array<{ date: Date; entryNumber: string; ref: string | null; description: string | null; debit: number; credit: number; balance: number }>;
      totalDebit: number; totalCredit: number; endingBalance: number;
    }>();
    for (const row of result.rows) {
      let account = accounts.get(row.account_id);
      if (!account) {
        account = { accountId: row.account_id, code: row.code, name: row.name, type: row.type,
          rows: [], totalDebit: 0, totalCredit: 0, endingBalance: openingByAccount.get(row.account_id) ?? 0 };
        accounts.set(row.account_id, account);
      }
      const debit = numberValue(row.debit);
      const credit = numberValue(row.credit);
      account.totalDebit += debit;
      account.totalCredit += credit;
      account.endingBalance += debit - credit;
      account.rows.push({ date: row.date, entryNumber: row.entry_number, ref: row.ref,
        description: row.description, debit, credit, balance: account.endingBalance });
    }
    res.json({ from: first(req.query.from) ?? null, to: first(req.query.to) ?? null, accounts: [...accounts.values()] });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/reports/cash-flow", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    const filters = companyFilter(req, values) + dateFilter(req, values);
    const result = await pool.query<{
      net_amount: string; counterpart_types: string; counterpart_names: string;
    }>(`
      select (cash.debit - cash.credit)::text net_amount,
        coalesce(string_agg(distinct other.account_type::text, ' '), '') counterpart_types,
        coalesce(string_agg(distinct other.account_name, ' '), '') counterpart_names
      from public.accounting_general_ledger_v cash
      left join public.accounting_general_ledger_v other
        on other.entry_id = cash.entry_id and other.line_id <> cash.line_id
      where cash.status::text = 'posted'
        and cash.account_type::text = 'asset'
        and cash.account_name ~* '(kas|bank)' ${filters.replaceAll("gl.", "cash.")}
      group by cash.line_id, cash.debit, cash.credit
    `, values);
    let operatingNet = 0;
    let investingNet = 0;
    let financingNet = 0;
    let unclassifiedNet = 0;
    let totalInflow = 0;
    let totalOutflow = 0;
    for (const row of result.rows) {
      const amount = Number(row.net_amount);
      if (amount >= 0) totalInflow += amount;
      else totalOutflow += Math.abs(amount);
      const context = `${row.counterpart_types} ${row.counterpart_names}`;
      if (/(fixed.?asset|aset tetap|kendaraan|peralatan|bangunan|tanah|depreciation|penyusutan)/i.test(context)) {
        investingNet += amount;
      } else if (/(equity|modal|pinjaman|loan|jangka panjang)/i.test(context)) {
        financingNet += amount;
      } else if (context.trim()) {
        operatingNet += amount;
      } else {
        unclassifiedNet += amount;
      }
    }
    const from = first(req.query.from) ?? first(req.query.startDate);
    let openingBalance = 0;
    if (from) {
      const openingValues: QueryValue[] = [];
      const company = companyFilter(req, openingValues, "cash.company_id");
      openingValues.push(from);
      const opening = await pool.query<{ balance: string }>(`
        select coalesce(sum(cash.debit - cash.credit), 0)::text balance
        from public.accounting_general_ledger_v cash
        where cash.status::text = 'posted' and cash.account_type::text = 'asset'
          and cash.account_name ~* '(kas|bank)' ${company}
          and cash.date < $${openingValues.length}::timestamptz
      `, openingValues);
      openingBalance = Number(opening.rows[0]?.balance ?? 0);
    }
    const netChange = operatingNet + investingNet + financingNet + unclassifiedNet;
    res.json({
      from: from ?? null,
      to: first(req.query.to) ?? first(req.query.endDate) ?? null,
      openingBalance, totalInflow, totalOutflow, netChange,
      operatingNet, investingNet, financingNet, unclassifiedNet,
      closingBalance: openingBalance + netChange,
    });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/entries", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    let filters = companyFilter(req, values) + dateFilter(req, values);
    const status = first(req.query.status);
    if (status && status !== "all") {
      values.push(status);
      filters += ` and gl.status::text = $${values.length}`;
    }

    const limit = Math.min(100, Math.max(1, Number(first(req.query.limit) ?? 25) || 25));
    const offset = Math.max(0, Number(first(req.query.offset) ?? 0) || 0);
    values.push(limit, offset);
    const result = await pool.query<{
      entry_id: number;
      entry_number: string;
      date: Date;
      description: string | null;
      total_debit: string;
      total_credit: string;
      status: string;
    }>(`
      select gl.entry_id, max(gl.entry_number) entry_number, min(gl.date) date,
             coalesce(max(nullif(gl.entry_description, '')),
                      max(nullif(gl.line_description, ''))) description,
             coalesce(sum(gl.debit), 0)::text total_debit,
             coalesce(sum(gl.credit), 0)::text total_credit,
             max(gl.status::text) status
      from public.accounting_general_ledger_v gl
      where true ${filters}
      group by gl.entry_id
      order by min(gl.date) desc, gl.entry_id desc
      limit $${values.length - 1} offset $${values.length}
    `, values);

    res.json(result.rows.map((row) => ({
      id: row.entry_id,
      number: row.entry_number,
      date: row.date,
      description: row.description,
      status: row.status,
      totalDebit: numberValue(row.total_debit),
      totalCredit: numberValue(row.total_credit),
    })));
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/dashboard/monthly-cash", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    const filters = companyFilter(req, values) + dateFilter(req, values);
    const result = await pool.query<{ month_key: string; net_change: string }>(`
      select to_char(date_trunc('month', gl.date), 'YYYY-MM') month_key,
             coalesce(sum(gl.debit - gl.credit), 0)::text net_change
      from public.accounting_general_ledger_v gl
      where gl.status::text = 'posted'
        and gl.account_type::text = 'asset'
        and gl.account_name ~* '(kas|bank)' ${filters}
      group by date_trunc('month', gl.date)
      order by date_trunc('month', gl.date)
    `, values);

    let saldo = 0;
    res.json({
      months: result.rows.map((row) => {
        saldo += numberValue(row.net_change);
        return { month: row.month_key, label: row.month_key, saldo };
      }),
    });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/reports/balance-sheet", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    const filters = companyFilter(req, values) + dateFilter(req, values) + branchFilter(req, values);
    const result = await pool.query<{
      account_id: number; company_id: number; company_code: string | null;
      code: string; name: string; type: string; amount: string;
    }>(`
      select gl.account_id, gl.company_id, coalesce(c.company_code, c.code) company_code,
             gl.account_code code, gl.account_name name, gl.account_type::text type,
             sum(case when gl.account_type::text = 'asset' then gl.debit - gl.credit else gl.credit - gl.debit end) amount
      from public.accounting_general_ledger_v gl
      left join public.companies c on c.id = gl.company_id
      where gl.status::text = 'posted' and gl.account_type::text in ('asset','liability','equity') ${filters}
      group by gl.account_id, gl.company_id, coalesce(c.company_code, c.code),
               gl.account_code, gl.account_name, gl.account_type
      order by company_code, code
    `, values);
    const rows = result.rows.map((row) => ({
      accountId: row.account_id, companyId: row.company_id, companyCode: row.company_code,
      code: row.code, name: row.name, type: row.type, amount: numberValue(row.amount),
    }));
    const assets = rows.filter((row) => row.type === "asset");
    const liabilities = rows.filter((row) => row.type === "liability");
    const equity = rows.filter((row) => row.type === "equity");
    const pl = await loadProfitLoss(req, fiscalYearPeriod(req));
    const totalAssets = assets.reduce((sum, row) => sum + row.amount, 0);
    const totalLiabilities = liabilities.reduce((sum, row) => sum + row.amount, 0);
    const totalEquity = equity.reduce((sum, row) => sum + row.amount, 0) + pl.netIncome;
    res.json({
      asOf: first(req.query.to) ?? new Date().toISOString(), assets, liabilities, equity,
      netIncomeYTD: pl.netIncome, totalAssets, totalLiabilities, totalEquity,
      totalLiabilitiesAndEquity: totalLiabilities + totalEquity,
    });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/dashboard-kpi", async (req, res): Promise<void> => {
  try {
    const month = Number(first(req.query.month) ?? new Date().getMonth() + 1);
    const year = Number(first(req.query.year) ?? new Date().getFullYear());
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) {
      res.status(400).json({ error: "Periode tidak valid" });
      return;
    }
    const companyId = requestedCompanyId(req);
    const values: QueryValue[] = [`${year}-${String(month).padStart(2, "0")}-01`];
    let companySql = "";
    if (companyId !== null) {
      values.push(companyId);
      companySql = ` and gl.company_id = $2`;
    }
    const result = await pool.query<{ cash_balance: string; revenue: string; expense: string }>(`
      select
        coalesce(sum(case when gl.account_type::text = 'asset' and gl.account_name ~* '(kas|bank)'
          and gl.date < ($1::date + interval '1 month') then gl.debit - gl.credit else 0 end), 0) cash_balance,
        coalesce(sum(case when gl.account_type::text = 'revenue' and gl.date >= $1::date
          and gl.date < ($1::date + interval '1 month') then gl.credit - gl.debit else 0 end), 0) revenue,
        coalesce(sum(case when gl.account_type::text = 'expense' and gl.date >= $1::date
          and gl.date < ($1::date + interval '1 month') then gl.debit - gl.credit else 0 end), 0) expense
      from public.accounting_general_ledger_v gl
      where gl.status::text = 'posted' ${companySql}
    `, values);
    const row = result.rows[0];
    const monthRevenue = numberValue(row.revenue);
    const monthExpense = numberValue(row.expense);
    res.json({
      cashBalance: numberValue(row.cash_balance), totalAr: 0, totalAp: 0,
      overdueInvoices: 0, overdueArAmount: 0, overdueBills: 0, overdueApAmount: 0,
      monthRevenue, monthExpense, monthNetPL: monthRevenue - monthExpense,
      periodYear: year, periodMonth: month,
    });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/hub/overview", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    const filters = companyFilter(req, values, "e.company_id") + dateFilter(req, values, "e.date");
    const errorValues: QueryValue[] = [];
    const errorCompanyFilter = companyFilter(req, errorValues, "pe.company_id");
    const [totals, modules, companies, errors] = await Promise.all([
      pool.query<{
        total_entries: number; total_companies: number; total_debit: string; total_credit: string;
        posted_count: number; voided_count: number;
      }>(`
        select count(*)::int total_entries, count(distinct e.company_id)::int total_companies,
          coalesce(sum(e.total_debit), 0) total_debit, coalesce(sum(e.total_credit), 0) total_credit,
          count(*) filter (where e.status::text = 'posted')::int posted_count,
          count(*) filter (where e.status::text in ('voided','cancelled'))::int voided_count
        from public.accounting_entries e where true ${filters}
      `, values),
      pool.query<{ module: string; entry_count: number; total_debit: string }>(`
        select coalesce(e.source_module, e.source::text, 'manual') module,
          count(*)::int entry_count, coalesce(sum(e.total_debit), 0) total_debit
        from public.accounting_entries e where true ${filters}
        group by 1 order by total_debit desc
      `, values),
      pool.query<{ company_id: number; company_name: string; entry_count: number; total_debit: string }>(`
        select e.company_id, coalesce(c.company_name, c.name, 'Perusahaan ' || e.company_id) company_name,
          count(*)::int entry_count, coalesce(sum(e.total_debit), 0) total_debit
        from public.accounting_entries e left join public.companies c on c.id = e.company_id
        where true ${filters} group by e.company_id, coalesce(c.company_name, c.name, 'Perusahaan ' || e.company_id)
        order by total_debit desc
      `, values),
      pool.query<{ count: number }>(
        `select count(*)::int count from public.accounting_posting_errors pe
         where pe.resolved_at is null ${errorCompanyFilter}`,
        errorValues,
      ),
    ]);
    res.json({
      totals: totals.rows[0], moduleBreakdown: modules.rows, companyBreakdown: companies.rows,
      pendingErrors: errors.rows[0]?.count ?? 0,
    });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/hub/posting-errors", async (req, res): Promise<void> => {
  try {
    const page = Math.max(1, Number(first(req.query.page) ?? 1) || 1);
    const limit = Math.min(100, Math.max(1, Number(first(req.query.limit) ?? 50) || 50));
    const offset = (page - 1) * limit;
    const unresolved = first(req.query.unresolved) !== "false";
    const sourceModule = first(req.query.source_module)?.trim();
    const values: QueryValue[] = [];
    let where = "where true";

    const companyId = requestedCompanyId(req);
    if (companyId !== null) {
      values.push(companyId);
      where += ` and pe.company_id = $${values.length}`;
    }
    if (sourceModule) {
      values.push(sourceModule);
      where += ` and pe.source_module = $${values.length}`;
    }
    if (unresolved) where += " and pe.resolved_at is null";

    const countResult = await pool.query<{ total: number }>(
      `select count(*)::int total
       from public.accounting_posting_errors pe
       ${where}`,
      values,
    );
    values.push(limit, offset);
    const rows = await pool.query<PostingErrorRow>(
      `select pe.id, pe.company_id, pe.branch_id, pe.source_module, pe.source_table,
              pe.source_id, pe.source_ref, pe.error_code, pe.error_message, pe.payload,
              pe.resolved_at, pe.resolved_by, pe.resolve_note, pe.created_at
       from public.accounting_posting_errors pe
       ${where}
       order by pe.created_at desc, pe.id desc
       limit $${values.length - 1} offset $${values.length}`,
      values,
    );

    res.json({
      data: rows.rows,
      total: countResult.rows[0]?.total ?? 0,
      page,
      limit,
    });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.patch("/accounting/hub/posting-errors/:id/resolve", async (req, res): Promise<void> => {
  try {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "ID error posting tidak valid" });
      return;
    }
    const resolveNote =
      typeof req.body?.resolve_note === "string" ? req.body.resolve_note.trim() : "";
    const resolvedBy = getDevSession(req)?.email ?? "development-admin";
    const companyId = requestedCompanyId(req);
    const values: QueryValue[] = [resolveNote, resolvedBy, id];
    let companySql = "";
    if (companyId !== null) {
      values.push(companyId);
      companySql = ` and company_id = $${values.length}`;
    }

    const result = await pool.query<PostingErrorUpdateRow>(
      `update public.accounting_posting_errors
       set resolved_at = now(), resolved_by = $2, resolve_note = $1
       where id = $3 and resolved_at is null ${companySql}
       returning id, resolved_at, resolved_by, resolve_note`,
      values,
    );
    if (result.rowCount === 0) {
      res.status(404).json({ error: "Error posting tidak ditemukan atau sudah diselesaikan" });
      return;
    }
    res.json({ ok: true, data: result.rows[0] });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/hub/trial-balance", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    const filters = companyFilter(req, values) + dateFilter(req, values);
    const result = await pool.query<TrialBalanceRow>(`
      with recursive direct as (
        select gl.account_id, gl.company_id, gl.branch_id, gl.division_id,
          sum(gl.debit) total_debit, sum(gl.credit) total_credit
        from public.accounting_general_ledger_v gl
        where gl.status::text = 'posted' ${filters}
        group by gl.account_id, gl.company_id, gl.branch_id, gl.division_id
      ), rolled as (
        select d.account_id, d.company_id, d.branch_id, d.division_id, d.total_debit, d.total_credit
        from direct d
        union all
        select a.parent_id, r.company_id, r.branch_id, r.division_id, r.total_debit, r.total_credit
        from rolled r
        join public.chart_of_accounts a on a.id = r.account_id
        where a.parent_id is not null
      )
      select r.account_id, a.code, a.name, coalesce(a.account_type::text, a.type::text) type,
        a.parent_id, coalesce(a.is_header, false) is_header, coalesce(a.is_postable, true) is_postable,
        r.company_id, r.branch_id, r.division_id, coalesce(c.company_name, c.name) company_name,
        coalesce(c.company_code, c.code) company_code, sum(r.total_debit)::text total_debit,
        sum(r.total_credit)::text total_credit, sum(r.total_debit - r.total_credit)::text balance,
        null::text counterparty_companies
      from rolled r
      join public.chart_of_accounts a on a.id = r.account_id
      left join public.companies c on c.id = r.company_id
      group by r.account_id, a.code, a.name, a.account_type, a.type, a.parent_id, a.is_header,
        a.is_postable, r.company_id, r.branch_id, r.division_id,
        coalesce(c.company_name, c.name), coalesce(c.company_code, c.code)
      order by company_code, a.code
    `, values);
    res.json({ data: result.rows });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/hub/profit-loss", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    let filters = companyFilter(req, values) + dateFilter(req, values) + branchFilter(req, values);
    const module = first(req.query.source_module);
    if (module) {
      values.push(module);
      filters += ` and coalesce(gl.source_module, '') = $${values.length}`;
    }
    const result = await pool.query<{
      account_type: string; account_id: number; code: string; name: string; expense_group: string | null;
      company_id: number; branch_id: number | null; division_id: number | null; source_module: string;
      period: string; total_debit: string; total_credit: string; net_amount: string;
    }>(`
      select gl.account_type::text account_type, gl.account_id, gl.account_code code, gl.account_name name,
        case when gl.account_type::text = 'expense' and
          (a.account_category::text = 'COGS' or gl.account_name ~* '(HPP|COGS|Harga Pokok)')
          then 'cogs' when gl.account_type::text = 'expense' then 'operating_expense' else null end expense_group,
        gl.company_id, gl.branch_id, gl.division_id, coalesce(gl.source_module, 'manual') source_module,
        to_char(date_trunc('month', gl.date), 'YYYY-MM') period,
        sum(gl.debit)::text total_debit, sum(gl.credit)::text total_credit,
        sum(case when gl.account_type::text = 'revenue' then gl.credit - gl.debit else gl.debit - gl.credit end)::text net_amount
      from public.accounting_general_ledger_v gl left join public.chart_of_accounts a on a.id = gl.account_id
      where gl.status::text = 'posted' and gl.account_type::text in ('revenue','expense') ${filters}
      group by gl.account_type, gl.account_id, gl.account_code, gl.account_name, expense_group,
        gl.company_id, gl.branch_id, gl.division_id, gl.source_module, date_trunc('month', gl.date)
      order by period, code
    `, values);
    const totalRevenue = result.rows.filter((r) => r.account_type === "revenue").reduce((s, r) => s + Number(r.net_amount), 0);
    const totalCogs = result.rows.filter((r) => r.expense_group === "cogs").reduce((s, r) => s + Number(r.net_amount), 0);
    const totalOperatingExpense = result.rows.filter((r) => r.expense_group === "operating_expense").reduce((s, r) => s + Number(r.net_amount), 0);
    res.json({ data: result.rows, summary: {
      total_revenue: totalRevenue, total_cogs: totalCogs, total_operating_expense: totalOperatingExpense,
      total_expense: totalCogs + totalOperatingExpense, gross_profit: totalRevenue - totalCogs,
      net_profit: totalRevenue - totalCogs - totalOperatingExpense,
    } });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/hub/balance-sheet", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    const filters = companyFilter(req, values) + dateFilter(req, values) + branchFilter(req, values);
    const result = await pool.query<{
      account_type: string; account_id: number; code: string; name: string; company_id: number;
      company_code: string | null; branch_id: number | null; total_debit: string; total_credit: string; balance: string;
    }>(`
      select gl.account_type::text account_type, gl.account_id, gl.account_code code, gl.account_name name,
        gl.company_id, coalesce(c.company_code, c.code) company_code, gl.branch_id,
        sum(gl.debit)::text total_debit, sum(gl.credit)::text total_credit,
        sum(case when gl.account_type::text = 'asset' then gl.debit - gl.credit else gl.credit - gl.debit end)::text balance
      from public.accounting_general_ledger_v gl left join public.companies c on c.id = gl.company_id
      where gl.status::text = 'posted' and gl.account_type::text in ('asset','liability','equity') ${filters}
      group by gl.account_type, gl.account_id, gl.account_code, gl.account_name, gl.company_id,
        coalesce(c.company_code, c.code), gl.branch_id order by company_code, code
    `, values);
    const totalAssets = result.rows.filter((r) => r.account_type === "asset").reduce((s, r) => s + Number(r.balance), 0);
    const totalLiabilities = result.rows.filter((r) => r.account_type === "liability").reduce((s, r) => s + Number(r.balance), 0);
    const currentEarnings = (await loadProfitLoss(req, fiscalYearPeriod(req))).netIncome;
    const earningsRow = {
      account_type: "equity", account_id: -1, code: "YTD", name: "Laba Berjalan",
      company_id: null, company_code: null, branch_id: null,
      total_debit: "0", total_credit: String(currentEarnings), balance: String(currentEarnings),
    };
    const data = currentEarnings === 0 ? result.rows : [...result.rows, earningsRow];
    const totalEquity = result.rows.filter((r) => r.account_type === "equity").reduce((s, r) => s + Number(r.balance), 0)
      + currentEarnings;
    res.json({ data, summary: {
      total_assets: totalAssets, total_liabilities: totalLiabilities, total_equity: totalEquity,
      balanced: Math.abs(totalAssets - totalLiabilities - totalEquity) < 1,
    } });
  } catch (error) {
    reportError(req, res, error);
  }
});

router.get("/accounting/hub/general-ledger", async (req, res): Promise<void> => {
  try {
    const values: QueryValue[] = [];
    let filters = companyFilter(req, values) + dateFilter(req, values) + branchFilter(req, values);
    const accountId = first(req.query.account_id);
    if (accountId) {
      const parsed = Number(accountId);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("INVALID_COMPANY");
      values.push(parsed);
      filters += ` and gl.account_id = $${values.length}`;
    }
    const module = first(req.query.source_module);
    if (module) {
      values.push(module);
      filters += ` and coalesce(gl.source_module, '') = $${values.length}`;
    }
    const paymentMethod = first(req.query.payment_method);
    if (paymentMethod) {
      values.push(paymentMethod);
      filters += ` and coalesce(e.payment_method, '') = $${values.length}`;
    }
    const limit = Math.min(Math.max(Number(first(req.query.limit) ?? 50), 1), 999999);
    const page = Math.max(Number(first(req.query.page) ?? 1), 1);
    if (!Number.isFinite(limit) || !Number.isFinite(page)) throw new Error("INVALID_FILTER");
    const sortBy = first(req.query.sort_by) ?? "date";
    const sortDirection = first(req.query.sort_dir) === "asc" ? "asc" : "desc";
    const sortable = new Set([
      "date", "month", "entry_number", "source_module", "account_code",
      "account_type", "partner_name", "ref", "debit", "credit", "status", "payment_method",
    ]);
    if (!sortable.has(sortBy)) throw new Error("INVALID_FILTER");
    const sortColumn: Record<string, string> = {
      date: "date",
      month: "date",
      entry_number: "entry_number",
      source_module: "source_module",
      account_code: "account_code",
      account_type: "account_type",
      partner_name: "partner_name",
      ref: "ref",
      debit: "debit",
      credit: "credit",
      status: "status",
      payment_method: "payment_method",
    };
    const orderBy = sortColumn[sortBy];
    const orderExpression = sortBy === "month" ? "date_trunc('month', date)" : orderBy;
    const mainValues = [...values, limit, (page - 1) * limit];
    const result = await pool.query<{
      line_id: number; entry_id: number; entry_number: string; company_id: number; branch_id: number | null;
      division_id: number | null; date: Date; source_module: string | null; source_schema: string | null;
      source_table: string | null; source_id: number | null; ref: string | null; entry_description: string | null;
      line_description: string | null; status: string; journal_name: string; journal_type: string;
      account_id: number; account_code: string; account_name: string; account_type: string;
      normal_balance: string; debit: string; credit: string; created_at: Date; posted_at: Date | null;
      payment_method: string | null; partner_name: string | null; running_balance: string;
      total_count: number; filtered_debit: string; filtered_credit: string;
    }>(`
      with base as (
        select gl.*, coalesce(a.normal_balance::text, 'DEBIT') normal_balance, e.payment_method,
          max(p.partner_name) partner_name
        from public.accounting_general_ledger_v gl
        left join public.chart_of_accounts a on a.id = gl.account_id
        left join public.accounting_entries e on e.id = gl.entry_id
        left join public.accounting_payments p on p.entry_id = gl.entry_id
        where gl.status::text = 'posted' ${filters}
        group by gl.line_id, gl.entry_id, gl.entry_number, gl.company_id, gl.branch_id, gl.division_id,
          gl.date, gl.source, gl.source_module, gl.source_schema, gl.source_table, gl.source_id,
          gl.ref, gl.entry_description, gl.line_description, gl.status, gl.journal_name, gl.journal_type,
          gl.account_id, gl.account_code, gl.account_name, gl.account_type, gl.debit, gl.credit,
          gl.created_at, gl.posted_at, gl.voided_at, a.normal_balance, e.payment_method
      ), enriched as (
        select base.*,
          sum(base.debit - base.credit) over (
            partition by base.account_id, base.company_id, base.branch_id, base.division_id
            order by base.date, base.entry_id, base.line_id
            rows between unbounded preceding and current row
          )::text running_balance,
          sum(base.debit) over()::text filtered_debit,
          sum(base.credit) over()::text filtered_credit
        from base
      )
      select enriched.*, count(*) over()::int total_count
      from enriched
      order by ${orderExpression} ${sortDirection}, line_id ${sortDirection}
      limit $${mainValues.length - 1} offset $${mainValues.length}
    `, mainValues);
    const from = first(req.query.date_from) ?? first(req.query.from);
    const contextKey = (row: { account_id: number; company_id: number; branch_id: number | null; division_id: number | null }) =>
      `${row.account_id}:${row.company_id}:${row.branch_id ?? "all"}:${row.division_id ?? "all"}`;
    const openingByContext = new Map<string, number>();
    if (from) {
      const openingValues: QueryValue[] = [];
      let openingFilters = companyFilter(req, openingValues) + branchFilter(req, openingValues);
      if (accountId) {
        openingValues.push(Number(accountId));
        openingFilters += ` and gl.account_id = $${openingValues.length}`;
      }
      if (module) {
        openingValues.push(module);
        openingFilters += ` and coalesce(gl.source_module, '') = $${openingValues.length}`;
      }
      if (paymentMethod) {
        openingValues.push(paymentMethod);
        openingFilters += ` and coalesce(e.payment_method, '') = $${openingValues.length}`;
      }
      openingValues.push(from);
      const opening = await pool.query<{
        account_id: number; company_id: number; branch_id: number | null; division_id: number | null; balance: string;
      }>(`
        select gl.account_id, gl.company_id, gl.branch_id, gl.division_id,
          coalesce(sum(gl.debit - gl.credit), 0)::text balance
        from public.accounting_general_ledger_v gl
        left join public.accounting_entries e on e.id = gl.entry_id
        where gl.status::text = 'posted' ${openingFilters}
          and gl.date < $${openingValues.length}::timestamptz
        group by gl.account_id, gl.company_id, gl.branch_id, gl.division_id
      `, openingValues);
      for (const row of opening.rows) openingByContext.set(contextKey(row), Number(row.balance));
    }
    const data = result.rows.map((row) => ({
      ...row, source_doc_number: null,
      running_balance: String(Number(row.running_balance) + (openingByContext.get(contextKey(row)) ?? 0)),
      account_opening_balance: String(openingByContext.get(contextKey(row)) ?? 0),
    }));
    const total = result.rows[0]?.total_count ?? 0;
    const totalDebit = Number(result.rows[0]?.filtered_debit ?? 0);
    const totalCredit = Number(result.rows[0]?.filtered_credit ?? 0);
    const openingBalance = [...openingByContext.values()].reduce((sum, value) => sum + value, 0);
    res.json({ data, total, totalDebit, totalCredit,
      openingBalance, closingBalance: openingBalance + totalDebit - totalCredit });
  } catch (error) {
    reportError(req, res, error);
  }
});

export default router;