/**
 * Issue #292 DB execution identity, read-only and fail-closed.
 * Checking BOTH identities prevents SET ROLE from promoting a privileged
 * administrative session into an apparently eligible finance connection.
 *
 * This is a necessary gate, not sufficient authorization: the HTTP actor,
 * company, historical owner rule and canonical bank evidence are separate.
 */
export async function isIssue292ScopedFinanceSession(
  client: {query: <T = Record<string, unknown>>(text:string) => Promise<{rows:T[]}>},
):Promise<boolean> {
  const result=await client.query<{
    db_principal:string;
    session_principal:string;
  }>("SELECT current_user AS db_principal, session_user AS session_principal");
  return result.rows.length===1
    && result.rows[0]?.db_principal==="sport_center_app"
    && result.rows[0]?.session_principal==="sport_center_app";
}
