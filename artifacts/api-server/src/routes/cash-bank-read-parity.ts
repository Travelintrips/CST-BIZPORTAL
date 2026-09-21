import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";

const router: IRouter = Router();
router.use(authenticateAdmin);

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveCompanyId(request: Request, response: Response): number | null {
  const requestedCompanyId = positiveInt(request.query.companyId);
  const sessionCompanyId = (request as AdminRequest).adminUser?.companyId ?? null;

  if (sessionCompanyId && requestedCompanyId && sessionCompanyId !== requestedCompanyId) {
    response.status(403).json({ error: "Company scope mismatch." });
    return null;
  }

  const companyId = sessionCompanyId ?? requestedCompanyId;
  if (!companyId) {
    response.status(400).json({ error: "companyId required" });
    return null;
  }

  return companyId;
}

router.get("/cash-bank/accounts", async (request, response): Promise<void> => {
  const companyId = resolveCompanyId(request, response);
  if (!companyId) return;

  try {
    const result = await pool.query(
      `select
         cba.*,
         coa.code as coa_code,
         coa.name as coa_name,
         cat.name as category_name,
         cat.color as category_color,
         coalesce((
           select sum(ael.debit) - sum(ael.credit)
             from public.accounting_entry_lines ael
             join public.accounting_entries ae on ae.id = ael.entry_id
            where ael.account_id = cba.coa_id
              and ae.company_id = $1
              and ae.status = 'posted'
         ), 0) as balance
       from public.company_bank_accounts cba
       left join public.chart_of_accounts coa on coa.id = cba.coa_id
       left join public.cash_bank_categories cat on cat.id = cba.category_id
       where cba.company_id = $1
       order by cba.is_active desc, cba.account_type, cba.name`,
      [companyId],
    );

    response.json({ data: result.rows });
  } catch (error) {
    request.log.error({ error, companyId }, "Standalone cash-bank accounts list failed");
    response.status(503).json({ error: "Cash/bank accounts unavailable." });
  }
});

export default router;
