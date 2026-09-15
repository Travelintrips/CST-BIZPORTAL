import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

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

router.get("/companies", async (req, res) => {
  try {
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
      order by coalesce(company_name, name), id
    `);

    res.json(
      result.rows.map((company) => ({
        id: company.id,
        companyName: company.company_name ?? company.name ?? `Perusahaan ${company.id}`,
        companyCode: company.company_code ?? company.code ?? "",
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