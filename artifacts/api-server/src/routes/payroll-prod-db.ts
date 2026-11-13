import {
  createDedicatedPayrollPool,
  pool as bizPortalPool,
  type PayrollDbClient,
  type PayrollDbQueryResult,
} from "@workspace/db";

// Strict opt-in and project pinning. Never fall back to the BizPortal shared pool.
// Even an enabled Payroll feature flag is insufficient without this gated source.
const PROD_REF = "nzdweipzckfszczzqtuw";
const DEV_REF = "xssrfshdrtdfupgqwfdw";
const PROD_LOGIN = "bizportal_payroll_prod_login";
let dedicated: ReturnType<typeof createDedicatedPayrollPool> | null = null;
let connectedUrl: string | null = null;

/** One existing BizPortal server login; no extra Payroll database password.
 * Requires the database's narrowly-scoped SET-only role grant to work.
 * NEVER enables Payroll write paths. Explicit opt-in only.
 */
export function payrollProdSharedReadOnlyEnabled(): boolean {
  return process.env.APP_ENV?.trim().toLowerCase() === "production" &&
    process.env.PAYROLL_PROD_SHARED_READONLY_ENABLED === "true";
}
function prodUrl(): string | null {
  if (process.env.APP_ENV?.trim().toLowerCase() !== "production" ||
      process.env.PAYROLL_PROD_REQUIRE_DEDICATED_DB !== "true" ||
      payrollProdSharedReadOnlyEnabled()) return null;
  const raw=process.env.PAYROLL_DATABASE_URL_PROD?.trim();
  if (!raw) return null;
  // Produce fixed, non-sensitive diagnostics only. Never reveal URL, user or password.
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw Error("PAYROLL_PROD_URL_MALFORMED"); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol))
    throw Error("PAYROLL_PROD_URL_SCHEME_INVALID");
  let user: string;
  try { user=decodeURIComponent(parsed.username); } catch { throw Error("PAYROLL_PROD_URL_MALFORMED"); }
  const host=parsed.hostname.toLowerCase();
  const directHost=host==="db."+PROD_REF+".supabase.co";
  const poolerHost=/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);
  if (host.includes(DEV_REF) || user.includes(DEV_REF))
    throw Error("PAYROLL_PROD_PROJECT_MISMATCH");
  if (![PROD_LOGIN,PROD_LOGIN+"."+PROD_REF].includes(user))
    throw Error("PAYROLL_PROD_USERNAME_MISMATCH");
  if (!(directHost || poolerHost))
    throw Error("PAYROLL_PROD_HOST_MISMATCH");
  if (poolerHost && user !== PROD_LOGIN+"."+PROD_REF)
    throw Error("PAYROLL_PROD_POOLER_USERNAME_SUFFIX_REQUIRED");
  if (!parsed.pathname || parsed.pathname==="/")
    throw Error("PAYROLL_PROD_DATABASE_NAME_MISSING");
  return raw;
}
export function payrollProdDedicatedRequired(): boolean { return prodUrl()!==null; }
export function payrollDedicatedEnabled(): boolean { return payrollProdDedicatedRequired(); }
export function payrollReadOnlyReady(): boolean {
  return payrollProdSharedReadOnlyEnabled() || payrollProdDedicatedRequired();
}
export function getPayrollPool() {
  const url=prodUrl();
  if (!url) throw Error("PAYROLL_PROD_DEDICATED_DATABASE_REQUIRED");
  if (!dedicated) { dedicated=createDedicatedPayrollPool(url); connectedUrl=url; }
  if (connectedUrl!==url) throw Error("PAYROLL_DATABASE_CHANGED_RESTART_REQUIRED");
  return dedicated;
}
export async function setPayrollCompanyScope(client: PayrollDbClient, companyId:number):Promise<void> {
  if (!Number.isSafeInteger(companyId)||companyId<=0) throw Error("PAYROLL_INVALID_COMPANY_SCOPE");
  if (!payrollReadOnlyReady()) throw Error("PAYROLL_PROD_READONLY_CONNECTION_REQUIRED");
  // Prod login role has NOINHERIT and has no table write grants.
  // Only this transaction is scoped into the least-privileged capability role.
  await client.query("SET LOCAL ROLE bizportal_payroll_prod");
  await client.query("SELECT set_config('app.payroll_company_id',$1,true)",[String(companyId)]);
}
export async function payrollScopedQuery(companyId:number,sql:string,values:unknown[]):Promise<PayrollDbQueryResult>{
  if (!Number.isSafeInteger(companyId) || companyId <= 0)
    throw Error("PAYROLL_INVALID_COMPANY_SCOPE");
  // Shared mode is READ ONLY, with an explicit least-privilege role transition
  // before the requested SELECT. Never fall back to postgres/BYPASSRLS.
  const shared = payrollProdSharedReadOnlyEnabled();
  const client=await (shared ? bizPortalPool : getPayrollPool()).connect();
  try {
    await client.query("BEGIN READ ONLY");
    await setPayrollCompanyScope(client,companyId);
    if (shared) {
      const identity=await client.query(
        "SELECT current_user AS role, current_setting('app.payroll_company_id',true) AS company",
      );
      if (identity.rowCount !== 1 || identity.rows[0]?.role !== "bizportal_payroll_prod" ||
          identity.rows[0]?.company !== String(companyId))
        throw Error("PAYROLL_SHARED_ROLE_OR_COMPANY_SCOPE_INVALID");
    }
    const result=await client.query(sql,values);
    await client.query("COMMIT");
    return result;
  }catch(error) {
    try{await client.query("ROLLBACK");}catch{}
    throw error;
  }finally {client.release();}
}
export async function closePayrollDedicatedPool():Promise<void>{
  const p=dedicated; dedicated=null;connectedUrl=null;
  if(p)await p.end();
}
