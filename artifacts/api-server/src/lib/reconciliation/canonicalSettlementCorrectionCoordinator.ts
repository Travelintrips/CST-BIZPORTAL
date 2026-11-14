import { sql } from "drizzle-orm";
import { reverseCanonicalSettlementForCorrection } from "./canonicalSettlementCorrection";
import type {
  CanonicalSettlementCorrectionInput,
  CanonicalSettlementCorrectionResult,
} from "./canonicalSettlementCorrection";

type DbClient = typeof import("@workspace/db").db;
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * A transaction boundary for the complete QRIS membership correction.
 *
 * IMPORTANT: this is intentionally NOT exposed through a route. The caller must
 * supply existing authenticated canonical batch-build and bank-approval operations
 * that use the SAME transaction handle. Never call a global DB connection from a
 * stage, or commit a reversal independently of its replacements.
 *
 * Once those operations have been wired and the two-bank end-to-end checks pass,
 * the integration can use this coordinator. Until then PR #296 stays draft.
 */
export async function runAtomicCanonicalSettlementCorrection<TBatches, TApprovals>(
  client: DbClient,
  input: CanonicalSettlementCorrectionInput,
  stages: {
    rebuildBothDatedBatches: (
      tx: Transaction,
      reversal: CanonicalSettlementCorrectionResult,
    ) => Promise<TBatches>;
    approveBothCanonicalBankMatches: (
      tx: Transaction,
      batches: TBatches,
      reversal: CanonicalSettlementCorrectionResult,
    ) => Promise<TApprovals>;
  },
): Promise<{
  reversal: CanonicalSettlementCorrectionResult;
  batches: TBatches;
  approvals: TApprovals;
}> {
  if (!stages || typeof stages.rebuildBothDatedBatches !== "function"
    || typeof stages.approveBothCanonicalBankMatches !== "function") {
    throw new Error("Both canonical replacement and bank approval stages are required.");
  }
  return client.transaction(async (tx) => {
    // The reversal writer's existing transaction entry point is reused, but its
    // callback receives the already-open outer tx. It cannot commit early.
    const scoped = {
      transaction: async <T>(callback: (innerTx: Transaction) => Promise<T>) => callback(tx),
    } as unknown as DbClient;
    const reversal = await reverseCanonicalSettlementForCorrection(scoped, input);
    if (!reversal.ok || reversal.settlementStatus !== "reversed") {
      throw new Error("Settlement reversal stage did not complete.");
    }
    const batches = await stages.rebuildBothDatedBatches(tx, reversal);
    const approvals = await stages.approveBothCanonicalBankMatches(tx, batches, reversal);
    // Issue #292 is deliberately restricted to the verified historical case.
    // A stage callback returning without doing the finance work must NEVER
    // commit the reversal. Re-read canonical DB records within the same tx.
    if (input.settlementId !== 5738 || input.expectedBankMutationId !== 434464
      || [...input.replacementPaymentIds].sort((a,b)=>a-b).join(",") !== "859,860,861,862") {
      throw new Error("Issue #292 coordinator rejects non-approved correction identity.");
    }
    const expected = [
      {mutationId:434462, date:"2026-11-04", ids:[834,843,853,856,858], gross:690000, mdr:4200, net:685800},
      {mutationId:434464, date:"2026-11-05", ids:[859,860,861,862], gross:930000, mdr:6300, net:923700},
    ];
    const used = new Set<number>();
    for (const cohort of expected) {
      const result = await tx.execute(sql`
        SELECT b.id AS batch_id, b.status::text AS batch_status,
          b.settlement_date::text AS settlement_date,
          b.gross_amount, b.mdr_amount, b.net_amount,
          b.settlement_journal_id, j.status::text AS journal_status,
          j.is_reversal, m.status::text AS bank_status,
          m.amount AS bank_amount, m.journal_entry_id,
          COALESCE(array_agg(i.payment_id ORDER BY i.payment_id)
            FILTER (WHERE i.payment_id IS NOT NULL),ARRAY[]::integer[]) AS payment_ids
        FROM sport_center.payment_settlement_batches b
        JOIN sport_center.accounting_journals j ON j.id=b.settlement_journal_id
        JOIN public.bank_mutations m ON m.id=b.bank_mutation_id
        LEFT JOIN sport_center.payment_settlement_items i
          ON i.settlement_id=b.id AND i.item_status='active'
        WHERE b.bank_mutation_id=${cohort.mutationId} AND b.company_id=1
        GROUP BY b.id,j.id,m.id
      `);
      if (result.rows.length !== 1) {
        throw new Error(`Issue #292 missing or duplicate canonical bank batch for ${cohort.mutationId}.`);
      }
      const row = result.rows[0] as Record<string,unknown>;
      const actualIds = (row.payment_ids as Array<number|string>).map(Number).sort((a,b)=>a-b);
      const valid = Number(row.batch_id) !== 5738
        && row.batch_status === "reconciled" && row.bank_status === "approved"
        && row.journal_status === "posted" && row.is_reversal === false
        && row.journal_entry_id == null
        && row.settlement_date === cohort.date
        && Number(row.gross_amount) === cohort.gross
        && Number(row.mdr_amount) === cohort.mdr
        && Number(row.net_amount) === cohort.net
        && Number(row.bank_amount) === cohort.net
        && actualIds.join(",") === cohort.ids.join(",");
      if (!valid || used.has(Number(row.batch_id))) {
        throw new Error(`Issue #292 canonical bank or membership postcondition failed: ${cohort.mutationId}.`);
      }
      // Posted alone is not sufficient: verify a nonzero balanced ledger
      // for every replacement settlement journal before the outer commit.
      const ledger = await tx.execute(sql`
        SELECT COALESCE(SUM(amount) FILTER (WHERE line_type='debit'),0) AS debits,
               COALESCE(SUM(amount) FILTER (WHERE line_type='credit'),0) AS credits,
               COALESCE(SUM(amount) FILTER (
                 WHERE line_type='debit' AND account_code='1-1023-CST'),0) AS bank_debit,
               COALESCE(SUM(amount) FILTER (
                 WHERE line_type='debit' AND account_code='5-3050-CST'),0) AS mdr_debit,
               COALESCE(SUM(amount) FILTER (
                 WHERE line_type='credit' AND account_code='1-1024-CST'),0) AS clearing_credit,
               COUNT(*)::integer AS lines
        FROM sport_center.accounting_journal_lines
        WHERE journal_id=${Number(row.settlement_journal_id)}
      `);
      const amounts = ledger.rows[0] as Record<string,unknown>|undefined;
      if (!amounts || Number(amounts.lines)!==3
        || Number(amounts.debits)!==cohort.gross
        || Number(amounts.credits)!==cohort.gross
        || Number(amounts.bank_debit)!==cohort.net
        || Number(amounts.mdr_debit)!==cohort.mdr
        || Number(amounts.clearing_credit)!==cohort.gross) {
        throw new Error(`Issue #292 posted journal bank/MDR/clearing amounts are not canonical: ${cohort.mutationId}.`);
      }
      used.add(Number(row.batch_id));
    }
    const original = await tx.execute(sql`
      SELECT b.status::text AS status,
        (SELECT count(*)::integer FROM sport_center.payment_settlement_items
          WHERE settlement_id=5738 AND item_status='active') AS active_members,
        (SELECT count(*)::integer FROM sport_center.accounting_journals
          WHERE reversal_of_id=b.settlement_journal_id AND is_reversal=true
            AND status='posted') AS posted_reversals
      FROM sport_center.payment_settlement_batches b WHERE b.id=5738
    `);
    const state = original.rows[0] as Record<string,unknown>|undefined;
    if (!state || state.status !== "reversed" || Number(state.active_members)!==0
      || Number(state.posted_reversals)!==1) {
      throw new Error("Issue #292 original posted settlement correction incomplete.");
    }
    return { reversal, batches, approvals };
  });
}


/**
 * Issue #292 canonical rebuild stage. Only call with the authenticated
 * coordinator's transaction after original #5738 has been reversed.
 * No independent transaction, no direct INSERTs, no approval and no route.
 *
 * 4 Nov: standard owner canonical builder.
 * 5 Nov: supplemental builder, since the reversed historical #5738 still
 * reserves its canonical identity under the unique reference constraints.
 */
export async function rebuildIssue292WithOwnerFunctions(
  tx: Transaction,
  reversal: CanonicalSettlementCorrectionResult,
  actor: string,
): Promise<{nov4BatchId:number;nov5BatchId:number}> {
  if (reversal.settlementId !== 5738 || reversal.bankMutationId !== 434464
    || reversal.settlementStatus !== "reversed"
    || [...reversal.replacementPaymentIds].sort((a,b)=>a-b).join(",") !== "859,860,861,862") {
    throw new Error("Issue #292 canonical rebuild requires the audited reversal identity.");
  }
  const operator=actor.trim();
  if (!operator) throw new Error("An authenticated correction actor is required.");
  const identityRows=await tx.execute(sql`
    SELECT company_id, lower(provider_code) AS provider_code,
      bank_account_id::text AS bank_account_id,
      settlement_rule_version AS rule_version
    FROM sport_center.payment_settlement_batches
    WHERE id=5738 AND status='reversed' FOR UPDATE
  `);
  const identity=identityRows.rows[0] as Record<string,unknown>|undefined;
  if (!identity || Number(identity.company_id)!==1 || !identity.provider_code
    || !identity.bank_account_id || !identity.rule_version) {
    throw new Error("Issue #292 source identity is not verified.");
  }
  const provider=String(identity.provider_code);
  const account=String(identity.bank_account_id);
  const rule=String(identity.rule_version);

  const bankMapping=await tx.execute(sql`
    SELECT cba.id
    FROM public.company_bank_accounts cba
    JOIN public.chart_of_accounts coa ON coa.id=cba.coa_id
    JOIN sport_center.coa_accounts sc ON sc.code=coa.code
    WHERE cba.company_id=1 AND cba.account_number::text=${account}
      AND cba.is_active=true AND coa.is_active=true AND sc.is_active=true
      AND coa.code='1-1023-CST' AND sc.code='1-1023-CST'
      AND coa.name='Bank Mandiri Ciputat' AND sc.name=coa.name
      AND coa.account_type::text='asset' AND sc.account_type::text='asset'
    FOR UPDATE OF cba,coa,sc
  `);
  if (bankMapping.rows.length!==1) {
    throw new Error("Issue #292 requires exactly one verified owner bank COA mapping.");
  }

  // Fail closed if either historical bank source is no longer eligible.
  const bankEvidence=await tx.execute(sql`
    SELECT m.id,m.amount,m.transaction_date::text AS date,m.status::text AS status,
      m.reconciliation_status::text AS reconciliation_status,
      m.company_id,m.source_classification,m.direction,m.journal_entry_id,
      m.approved_at,m.posted_at,a.company_id AS bank_company,
      a.account_number,a.is_active,
      EXISTS(
        SELECT 1 FROM public.bank_reconciliation_matches candidate
        WHERE candidate.mutation_id=m.id AND candidate.status='approved'
      ) AS has_prior_approved_match
    FROM public.bank_mutations m
    JOIN public.company_bank_accounts a ON a.id::text=m.bank_account_id
    WHERE m.id IN (434462,434464)
    ORDER BY m.id FOR UPDATE OF m,a
  `);
  if (bankEvidence.rows.length!==2) {
    throw new Error("Issue #292 requires two authentic bank rows.");
  }
  for (const row of bankEvidence.rows as Array<Record<string,unknown>>) {
    const id=Number(row.id),date=id===434462?"2026-11-04":"2026-11-05";
    const net=id===434462?685800:923700;
    if (![434462,434464].includes(id) || Number(row.company_id)!==1
      || Number(row.bank_company)!==1 || row.is_active!==true
      || row.account_number!==account || row.source_classification!=="actual_bank_mutation"
      || row.direction!=="IN" || row.status!=="unmatched"
      || row.reconciliation_status!=="unmatched"
      || row.has_prior_approved_match!==false || row.date!==date
      || Number(row.amount)!==net || row.journal_entry_id!=null
      || row.approved_at!=null || row.posted_at!=null) {
      throw new Error("Issue #292 bank evidence mismatch.");
    }
  }
  const expected=[
    {date:"2026-11-04",ids:[834,843,853,856,858],gross:690000,mdr:4200,net:685800},
    {date:"2026-11-05",ids:[859,860,861,862],gross:930000,mdr:6300,net:923700},
  ] as const;
  const built:number[]=[];
  for (const cohort of expected) {
    const paymentRows=await tx.execute(sql`
      SELECT p.id,p.amount,p.mdr_amount,p.company_id,p.status::text AS status,
        p.payment_method::text AS method,p.payment_provider::text AS provider,
        p.bank_account_id::text AS bank_account,
        p.settlement_rule_version AS rule_version,
        p.expected_settlement_date::text AS expected_date,
        p.settlement_status::text AS settlement_status,
        ((p.paid_at AT TIME ZONE 'Asia/Jakarta')::date+1)::text AS h_plus_one,
        (SELECT count(*)::integer FROM sport_center.accounting_journals j
          WHERE j.payment_id=p.id AND j.journal_type='payment_confirmed'
            AND j.is_reversal=false AND j.status='posted') AS source_journal_count
      FROM sport_center.sport_payments p
      WHERE p.id=ANY(ARRAY[${sql.join(cohort.ids.map(id => sql`${id}`), sql`, `)}]::integer[])
      ORDER BY p.id FOR UPDATE
    `);
    const rows=paymentRows.rows as Array<Record<string,unknown>>;
    if (rows.length!==cohort.ids.length || rows.some((row,i)=>
      Number(row.id)!==cohort.ids[i] || Number(row.company_id)!==1
      || row.status!=="confirmed" || String(row.method).toLowerCase()!=="qris"
      || String(row.provider).toLowerCase()!==provider
      || String(row.bank_account)!==account || String(row.rule_version)!==rule
      || row.h_plus_one!==cohort.date || row.expected_date!==cohort.date
      || row.amount==null || row.mdr_amount==null
      || Number(row.source_journal_count)!==1
      || String(row.settlement_status).toLowerCase()!=="unsettled"
    )) throw new Error(`Issue #292 source payments fail canonical H+1 evidence: ${cohort.date}`);
    const grossCents=rows.reduce((n,r)=>n+Math.round(Number(r.amount)*100),0);
    const mdrCents=rows.reduce((n,r)=>n+Math.round(Number(r.mdr_amount)*100),0);
    if (grossCents!==cohort.gross*100 || mdrCents!==cohort.mdr*100
      || grossCents-mdrCents!==cohort.net*100) {
      throw new Error(`Issue #292 source totals fail exact bank evidence: ${cohort.date}`);
    }

    let batchResult;
    if (cohort.date==="2026-11-05") {
      batchResult=await tx.execute(sql`
        SELECT sport_center.create_payment_settlement_supplemental_batch(
          1,${provider},${account},${cohort.date}::date,${rule},
          ARRAY[${sql.join(cohort.ids.map(id => sql`${id}`), sql`, `)}]::integer[],${operator}
        ) AS id
      `);
    } else {
      const refRows=await tx.execute(sql`
        SELECT settlement_reference FROM sport_center.canonical_settlement_group_identity(
          1,${provider},${account},${cohort.date}::date,${rule}
        )
      `);
      const reference=String((refRows.rows[0] as Record<string,unknown>|undefined)?.settlement_reference??"");
      if (!reference) throw new Error("Issue #292 canonical group identity missing.");
      batchResult=await tx.execute(sql`
        SELECT sport_center.create_payment_settlement_batch(
          ${reference},1,${provider},${account},${cohort.date}::date,
          ARRAY[${sql.join(cohort.ids.map(id => sql`${id}`), sql`, `)}]::integer[],${operator}
        ) AS id
      `);
    }
    const batchId=Number((batchResult.rows[0] as Record<string,unknown>|undefined)?.id);
    if (!Number.isSafeInteger(batchId) || batchId<=0 || batchId===5738
      || built.includes(batchId)) throw new Error("Issue #292 owner batch returned invalid ID.");
    const calculated=await tx.execute(sql`
      SELECT b.status::text AS status,
        b.settlement_date::text AS date, b.gross_amount,b.mdr_amount,b.net_amount,
        ARRAY(SELECT i.payment_id FROM sport_center.payment_settlement_items i
          WHERE i.settlement_id=b.id AND i.item_status='active'
          ORDER BY i.payment_id) AS payment_ids
      FROM sport_center.payment_settlement_batches b
      WHERE b.id=${batchId} AND b.company_id=1
      FOR UPDATE OF b
    `);
    const calculatedRow=calculated.rows[0] as Record<string,unknown>|undefined;
    const builtPayments=Array.isArray(calculatedRow?.payment_ids)
      ? calculatedRow.payment_ids.map(Number).sort((a,b)=>a-b) : [];
    if (!calculatedRow || calculatedRow.status!=="calculated" || calculatedRow.date!==cohort.date
      || Number(calculatedRow.gross_amount)!==cohort.gross
      || Number(calculatedRow.mdr_amount)!==cohort.mdr
      || Number(calculatedRow.net_amount)!==cohort.net
      || builtPayments.join(",")!==cohort.ids.join(",")) {
      throw new Error(`Issue #292 owner-calculated batch differs from exact bank gross/MDR/net or membership: ${cohort.date}`);
    }
    // A wrong owner rule or 0.3%/0.7% mismatch must fail BEFORE creating
    // or posting a settlement journal. The outer transaction rolls back.
    await tx.execute(sql`
      SELECT sport_center.create_settlement_journal_draft(
        ${batchId}::bigint,'1-1023-CST',${operator}
      )
    `);
    await tx.execute(sql`SELECT set_config(
      'sport_center.allow_posted_accounting_metadata_correction','on',true
    )`);
    await tx.execute(sql`
      SELECT sport_center.finalize_payment_settlement(${batchId}::bigint,${operator})
    `);
    const posted=await tx.execute(sql`
      SELECT status::text AS status,settlement_journal_id
      FROM sport_center.payment_settlement_batches WHERE id=${batchId} FOR UPDATE
    `);
    if ((posted.rows[0] as Record<string,unknown>|undefined)?.status!=="posted"
      || !Number((posted.rows[0] as Record<string,unknown>|undefined)?.settlement_journal_id)) {
      throw new Error("Issue #292 owner journal finalization did not post.");
    }
    built.push(batchId);
  }
  return {nov4BatchId:built[0]!,nov5BatchId:built[1]!};
}
