import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import {
  getDevSession,
  getProductionSession,
  getProductionUser,
  isDevelopmentEnvironment,
} from "./dev-auth";

interface CompanyRow {
  id: number;
  company_name: string | null;
  name: string | null;
  company_code: string | null;
  code: string | null;
  logo_url: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  npwp: string | null;
  is_active: boolean | null;
  is_holding: boolean | null;
}

const router: IRouter = Router();

const authorizeCompanyRoutes = async (req: any, res: any, next: any) => {
  try {
    if (isDevelopmentEnvironment()) {
      if (!getDevSession(req)) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      next();
      return;
    }
    const session = getProductionSession(req);
    if (!session) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!await getProductionUser(session)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  } catch (error) {
    req.log.error({ error }, "Company authorization failed");
    res.status(503).json({ error: "Authorization service unavailable." });
  }
};

router.use(["/companies", "/companies/list", "/accounting/companies"], authorizeCompanyRoutes);

router.get(["/companies", "/companies/list", "/accounting/companies"], async (req, res) => {
  try {
    const sessionCompanyId = getDevSession(req)?.companyId ?? null;
    const result = await pool.query<CompanyRow>(`
      select
        id,
        company_name,
        name,
        company_code,
        code,
        logo_url,
        address,
        phone,
        email,
        npwp,
        is_active,
        is_holding
      from public.companies
      where coalesce(is_active, true) = true
        and ($1::int is null or id = $1)
      order by coalesce(company_name, name), id
    `, [sessionCompanyId]);

    res.json(
      result.rows.map((company) => ({
        id: company.id,
        companyName: company.company_name ?? company.name ?? `Perusahaan ${company.id}`,
        companyCode: company.company_code ?? company.code ?? "",
        name: company.company_name ?? company.name ?? `Perusahaan ${company.id}`,
        code: company.company_code ?? company.code ?? "",
        logoUrl: company.logo_url,
        address: company.address,
        phone: company.phone,
        email: company.email,
        npwp: company.npwp,
        isActive: company.is_active ?? true,
        isHolding: company.is_holding ?? false,
      })),
    );
  } catch (error) {
    req.log.error({ error }, "Failed to load companies from Supabase");
    res.status(503).json({ error: "Daftar perusahaan tidak dapat dimuat" });
  }
});

export default router;