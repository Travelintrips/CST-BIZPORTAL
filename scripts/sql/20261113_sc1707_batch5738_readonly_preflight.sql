-- Issue #292: read-only reconciliation preflight for SC-1707 / SC-1720
-- NO DML, no batch reversal, no trigger bypass, no accounting writes.
-- This report checks the exact H+1 cohorts against both genuine bank rows.
-- A PASS here is only eligibility evidence; it is NOT approval or posting.
WITH expected AS (
  SELECT DATE '2026-11-04' AS settlement_date, 434462 AS mutation_id,
         ARRAY[834,843,853,856,858]::int[] AS payment_ids,
         685800::numeric AS target_net
  UNION ALL
  SELECT DATE '2026-11-05', 434464,
         ARRAY[859,860,861,862]::int[], 923700::numeric
), cohort AS (
  SELECT e.settlement_date,e.mutation_id,e.payment_ids,e.target_net,
         COUNT(p.id) AS payment_count,
         COALESCE(SUM(p.amount),0)::numeric AS gross,
         COALESCE(SUM(p.mdr_amount),0)::numeric AS mdr,
         COALESCE(SUM(p.amount-p.mdr_amount),0)::numeric AS net,
         BOOL_AND(p.status::text='confirmed'
           AND lower(p.payment_provider::text)='mandiri_direct'
           AND p.company_id=1
           AND p.bank_account_id='1640006707220'
           AND (p.paid_at AT TIME ZONE 'Asia/Jakarta')::date=e.settlement_date-1
           AND p.expected_settlement_date::date=e.settlement_date
         ) AS core_payment_evidence,
         COUNT(DISTINCT si.payment_id)
           FILTER (WHERE si.item_status='active') AS active_payment_memberships
    FROM expected e
    CROSS JOIN LATERAL unnest(e.payment_ids) pid(id)
    LEFT JOIN sport_center.sport_payments p ON p.id=pid.id
    LEFT JOIN sport_center.payment_settlement_items si
      ON si.payment_id=p.id AND si.item_status='active'
   GROUP BY e.settlement_date,e.mutation_id,e.payment_ids,e.target_net
)
SELECT c.settlement_date,c.mutation_id,
       m.status AS bank_status,m.amount AS actual_bank_amount,
       c.payment_ids,c.payment_count,c.gross,c.mdr,c.net,c.target_net,
       c.active_payment_memberships,c.core_payment_evidence,
       (c.payment_count=cardinality(c.payment_ids)
        AND c.net=c.target_net AND m.amount=c.target_net
        AND m.transaction_date::date=c.settlement_date
        AND c.core_payment_evidence) AS amount_and_date_pass,
       (c.active_payment_memberships=0) AS eligible_for_new_batch_now
  FROM cohort c
  JOIN public.bank_mutations m ON m.id=c.mutation_id
 ORDER BY c.settlement_date;

-- Historical posted batch and its journal must be corrected together.
SELECT b.id,b.status,b.settlement_date,b.gross_amount,b.mdr_amount,
       b.net_amount,b.settlement_journal_id,
       b.bank_mutation_id,b.canonical_bank_mutation_id,
       j.status AS journal_status,j.is_reversal,
       (SELECT array_agg(i.payment_id ORDER BY i.payment_id)
          FROM sport_center.payment_settlement_items i
         WHERE i.settlement_id=b.id AND i.item_status='active') AS active_payment_ids,
       (SELECT COUNT(*) FROM sport_center.accounting_journals jr
         WHERE jr.reversal_of_id=j.id AND jr.is_reversal=true
           AND jr.status='posted') AS posted_reversal_count
  FROM sport_center.payment_settlement_batches b
  JOIN sport_center.accounting_journals j ON j.id=b.settlement_journal_id
 WHERE b.id=5738;

-- IMPORTANT: when the historic batch is posted AND item memberships active,
-- never manually UPDATE/DELETE items, never call link-only recovery to mask
-- a wrong membership, and never record both bank mutations as settled.
-- Issue #292 requires a tested, atomic compensating journal and membership
-- reversal path before either replacement cohort can be approved.
