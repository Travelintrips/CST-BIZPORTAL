import { pool } from "@workspace/db";

/**
 * Executes one HRD unit of work under a non-login, NO-BYPASSRLS database role.
 * The verified company ID must come from the server-side authenticated user,
 * never from a body/query value. The scope is transaction-local and cannot
 * leak when the pooled connection is returned.
 */
export async function withHrdCompanyScope<T>(
  verifiedCompanyId: number,
  work: (client: Awaited<ReturnType<typeof pool.connect>>) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(verifiedCompanyId) || verifiedCompanyId <= 0) {
    throw new Error("HRD_COMPANY_SCOPE_INVALID");
  }
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN");
    inTransaction = true;
    await client.query("SET LOCAL ROLE bizportal_hrd_prod");
    await client.query(
      "SELECT set_config('app.hrd_company_id', $1, true)",
      [String(verifiedCompanyId)],
    );
    const result = await work(client);
    await client.query("COMMIT");
    inTransaction = false;
    return result;
  } catch (error) {
    if (inTransaction) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}
