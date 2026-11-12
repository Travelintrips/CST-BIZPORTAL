-- READ-ONLY diagnosis. Never run an UPDATE/DELETE or re-post the historical
-- imports from these matches. Used for SC-1741 / Mandiri Ciputat follow-up.
-- Source evidence: legacy bank_mutations.raw_payload.kredit is rupiah with
-- Indonesian thousands separators (e.g. 1.421.250), while old amount may
-- represent 1.421. New importer uses locale-aware parsing.
WITH historical AS (
  SELECT
    b.id, b.transaction_date, b.description, b.amount, b.status,
    b.mutation_key,
    replace(b.raw_payload->>'kredit', '.', '')::numeric AS evidence_amount
  FROM public.bank_mutations b
  WHERE b.raw_payload ? 'kredit'
    AND b.raw_payload->>'kredit' ~ '^[0-9]{1,3}(\.[0-9]{3})+$'
    AND b.direction = 'IN'
    AND b.amount IS DISTINCT FROM replace(b.raw_payload->>'kredit', '.', '')::numeric
),
classification AS (
  SELECT h.*,
    EXISTS (
      SELECT 1 FROM public.bank_mutations canonical
      WHERE canonical.id <> h.id
        AND canonical.transaction_date = h.transaction_date
        AND canonical.amount = h.evidence_amount
        AND canonical.direction = 'IN'
        AND canonical.description = h.description
        AND canonical.source = 'google_sheet'
        AND canonical.bank_account_id = '2'
    ) AS already_in_mandiri_sheet,
    EXISTS (
      SELECT 1 FROM public.bank_mutations canonical
      WHERE canonical.id <> h.id
        AND canonical.transaction_date = h.transaction_date
        AND canonical.amount = h.evidence_amount
        AND canonical.direction = 'IN'
        AND canonical.description = h.description
        AND canonical.source = 'google_sheet'
        AND canonical.bank_account_id = '2'
        AND canonical.status IN ('approved','posted','approved_pending_posting')
    ) AS has_final_counterpart
  FROM historical h
)
SELECT
  count(*) AS historical_incorrect,
  count(*) FILTER (WHERE already_in_mandiri_sheet) AS duplicate_of_scoped_sheet,
  count(*) FILTER (WHERE has_final_counterpart) AS has_final_counterpart,
  count(*) FILTER (WHERE NOT already_in_mandiri_sheet) AS needs_source_verification
FROM classification;
