/**
 * Issue #292: read-only rule-parity gate within the caller's SQL transaction.
 * The DEV config currently differs from the historical PROD owner rule.
 * Never compensate #5738 and only then discover that the replacement owner
 * builder would calculate different MDR amounts.
 */
type QueryClient = {
  query: <T = Record<string,unknown>>(text: string,values?: unknown[]) =>
    Promise<{rows:T[]}>;
};

export async function assertIssue292OwnerRuleParity(client: QueryClient):Promise<void> {
  const result=await client.query<{
    settlement_date:string;
    active_count:number|string;
    expected_count:number|string;
  }>(`
    SELECT d.day::text AS settlement_date,
      count(c.id)::int AS active_count,
      count(c.id) FILTER (WHERE
        c.rule_version='PROD-MANDIRI-SC-20260831-v1'
        AND c.mdr_rate=0.007
        AND c.calculation_method='percentage_of_gross'
        AND coalesce(c.fixed_provider_fee,0)=0
        AND coalesce(c.fee_tax_rate,0)=0
        AND c.rounding_scale=2
        AND c.rounding_method='round_half_up'
      )::int AS expected_count
    FROM (VALUES (DATE '2026-11-04'),(DATE '2026-11-05')) AS d(day)
    LEFT JOIN sport_center.payment_settlement_configs c
      ON c.company_id=1 AND lower(c.provider_code)='mandiri_direct'
      AND c.bank_account_id='1640006707220'
      AND c.source='OWNER_APPROVED' AND c.is_active=true
      AND c.effective_from<=d.day
      AND (c.effective_until IS NULL OR d.day<c.effective_until)
    GROUP BY d.day ORDER BY d.day
  `);
  if (result.rows.length!==2
    || result.rows[0]?.settlement_date!=="2026-11-04"
    || result.rows[1]?.settlement_date!=="2026-11-05"
    || result.rows.some(row => Number(row.active_count)!==1
      || Number(row.expected_count)!==1)) {
    throw new Error("ISSUE292_OWNER_RULE_NOT_PARITY: historical Mandiri 0.7% owner rule is not uniquely active for both dates.");
  }
}
