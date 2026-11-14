-- Snapshot of named DEV lifecycle guards on 2026-11-14.
-- ONLY for isolated PostgreSQL synthetic fixture; never apply to DEV or PROD.
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "settlement_reference" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "provider_name" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "provider_fee_amount" numeric;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "tax_withheld_amount" numeric;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "adjustment_amount" numeric;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "calculated_at" timestamptz;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "calculated_by" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "posted_at" timestamptz;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "posted_by" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "reconciled_at" timestamptz;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "reconciled_by" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "reversed_at" timestamptz;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "reversed_by" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "voided_at" timestamptz;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "voided_by" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "reversal_of_id" bigint;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "provider_settlement_reference" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "provider_batch_id" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "provider_statement_reference" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "source" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "correlation_id" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "notes" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "created_by" text;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "created_at" timestamptz;
ALTER TABLE sport_center.payment_settlement_batches ADD COLUMN "fee_tax_amount" numeric;

CREATE OR REPLACE FUNCTION sport_center.guard_finalized_settlement_items()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
DECLARE
  v_settlement_id bigint;
  v_status text;
  v_original_journal_id integer;
BEGIN
  v_settlement_id :=
    CASE WHEN TG_OP='DELETE' THEN OLD.settlement_id ELSE NEW.settlement_id END;
  SELECT status,settlement_journal_id
    INTO v_status,v_original_journal_id
    FROM sport_center.payment_settlement_batches
   WHERE id=v_settlement_id;

  IF TG_OP='UPDATE'
     AND current_setting('sport_center.allow_finalized_membership_reversal',true)
         = 'owner-audited-compensation-v1'
     AND v_status='reversed'
     AND OLD.item_status='active'
     AND NEW.item_status='reversed'
     AND OLD.settlement_id=NEW.settlement_id
     AND (to_jsonb(NEW)-'item_status') IS NOT DISTINCT FROM
         (to_jsonb(OLD)-'item_status')
     AND EXISTS(
       SELECT 1
         FROM sport_center.accounting_journals j
         JOIN sport_center.accounting_journal_lines l ON l.journal_id=j.id
        WHERE j.reversal_of_id=v_original_journal_id
          AND j.settlement_batch_id=v_settlement_id
          AND j.is_reversal=true
          AND j.status='posted'
          AND j.journal_type='settlement'
        GROUP BY j.id
       HAVING SUM(CASE WHEN l.line_type='debit' THEN l.amount ELSE 0 END)
            = SUM(CASE WHEN l.line_type='credit' THEN l.amount ELSE 0 END)
          AND SUM(CASE WHEN l.line_type='debit' THEN l.amount ELSE 0 END)>0
     )
  THEN
    RETURN NEW;
  END IF;

  IF v_status IN ('posted','reconciled','reversed') THEN
    RAISE EXCEPTION
      'FINALIZED_SETTLEMENT_ITEMS_ARE_IMMUTABLE: settlement=% status=%',
      v_settlement_id,v_status;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION sport_center.guard_posted_accounting_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.status IN ('posted', 'reversed') THEN
    RAISE EXCEPTION
      'POSTED_ACCOUNTING_JOURNAL_CANNOT_BE_DELETED: %',
      OLD.id;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status = 'posted' THEN
    IF COALESCE(
         current_setting(
           'sport_center.allow_posted_accounting_metadata_correction',
           true
         ),
         'off'
       ) = 'on' THEN
      IF (
        to_jsonb(NEW) - ARRAY[
          'payment_method',
          'payment_provider',
          'company_id',
          'bank_account_id',
          'provider_name',
          'provider_id',
          'payment_type',
          'expected_settlement_date',
          'settlement_status',
          'mdr_rate',
          'mdr_amount',
          'provider_reference',
          'provider_order_id',
          'merchant_trade_no',
          'provider_trade_no'
        ]::text[]
      ) IS DISTINCT FROM (
        to_jsonb(OLD) - ARRAY[
          'payment_method',
          'payment_provider',
          'company_id',
          'bank_account_id',
          'provider_name',
          'provider_id',
          'payment_type',
          'expected_settlement_date',
          'settlement_status',
          'mdr_rate',
          'mdr_amount',
          'provider_reference',
          'provider_order_id',
          'merchant_trade_no',
          'provider_trade_no'
        ]::text[]
      ) THEN
        RAISE EXCEPTION
          'POSTED_ACCOUNTING_JOURNAL_FINANCIAL_FIELDS_IMMUTABLE: %',
          OLD.id;
      END IF;
    ELSIF (
      to_jsonb(NEW) - ARRAY[
        'payment_method',
        'payment_provider'
      ]::text[]
    ) IS DISTINCT FROM (
      to_jsonb(OLD) - ARRAY[
        'payment_method',
        'payment_provider'
      ]::text[]
    ) THEN
      RAISE EXCEPTION
        'POSTED_ACCOUNTING_JOURNAL_FINANCIAL_FIELDS_IMMUTABLE: %',
        OLD.id;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.status = 'reversed' THEN
    RAISE EXCEPTION
      'REVERSED_ACCOUNTING_JOURNAL_IS_IMMUTABLE: %',
      OLD.id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION sport_center.guard_posted_settlement_batch()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
    DECLARE
      v_owner_recovery boolean :=
        current_setting('sport_center.canonical_settlement_recovery', true)
          = 'owner-net-correction-v1';
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('posted', 'reconciled', 'reversed') THEN
          RAISE EXCEPTION
            'POSTED_SETTLEMENT_CANNOT_BE_DELETED: %',
            OLD.id;
        END IF;
        RETURN OLD;
      END IF;

      IF OLD.status IN ('posted', 'reconciled', 'reversed') THEN
        IF v_owner_recovery THEN
          IF OLD.status <> 'posted'
             OR NEW.status <> 'reconciled'
             OR OLD.bank_mutation_id IS NOT NULL
             OR NEW.bank_mutation_id IS NULL
             OR NEW.net_amount IS NULL
             OR NEW.adjustment_amount IS NULL
             OR NEW.company_id IS DISTINCT FROM OLD.company_id
             OR NEW.provider_code IS DISTINCT FROM OLD.provider_code
             OR NEW.provider_name IS DISTINCT FROM OLD.provider_name
             OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
             OR NEW.settlement_date IS DISTINCT FROM OLD.settlement_date
             OR NEW.settlement_reference IS DISTINCT FROM OLD.settlement_reference
             OR NEW.gross_amount IS DISTINCT FROM OLD.gross_amount
             OR NEW.mdr_amount IS DISTINCT FROM OLD.mdr_amount
             OR NEW.provider_fee_amount IS DISTINCT FROM OLD.provider_fee_amount
             OR NEW.fee_tax_amount IS DISTINCT FROM OLD.fee_tax_amount
             OR NEW.tax_withheld_amount IS DISTINCT FROM OLD.tax_withheld_amount
             OR NEW.settlement_journal_id IS DISTINCT FROM OLD.settlement_journal_id
             OR NEW.settlement_rule_version IS DISTINCT FROM OLD.settlement_rule_version
             OR NEW.provider_settlement_reference IS DISTINCT FROM OLD.provider_settlement_reference
             OR NEW.provider_batch_id IS DISTINCT FROM OLD.provider_batch_id
          THEN
            RAISE EXCEPTION
              'POSTED_SETTLEMENT_RECOVERY_UPDATE_NOT_ALLOWED: %',
              OLD.id;
          END IF;
        ELSIF NEW.company_id IS DISTINCT FROM OLD.company_id
           OR NEW.provider_code IS DISTINCT FROM OLD.provider_code
           OR NEW.provider_name IS DISTINCT FROM OLD.provider_name
           OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
           OR NEW.settlement_date IS DISTINCT FROM OLD.settlement_date
           OR NEW.settlement_reference IS DISTINCT FROM OLD.settlement_reference
           OR NEW.gross_amount IS DISTINCT FROM OLD.gross_amount
           OR NEW.mdr_amount IS DISTINCT FROM OLD.mdr_amount
           OR NEW.provider_fee_amount IS DISTINCT FROM OLD.provider_fee_amount
           OR NEW.fee_tax_amount IS DISTINCT FROM OLD.fee_tax_amount
           OR NEW.tax_withheld_amount IS DISTINCT FROM OLD.tax_withheld_amount
           OR NEW.adjustment_amount IS DISTINCT FROM OLD.adjustment_amount
           OR NEW.net_amount IS DISTINCT FROM OLD.net_amount
           OR NEW.settlement_journal_id IS DISTINCT FROM OLD.settlement_journal_id
           OR NEW.settlement_rule_version IS DISTINCT FROM OLD.settlement_rule_version
           OR NEW.provider_settlement_reference IS DISTINCT FROM OLD.provider_settlement_reference
           OR NEW.provider_batch_id IS DISTINCT FROM OLD.provider_batch_id
        THEN
          RAISE EXCEPTION
            'POSTED_SETTLEMENT_FINANCIAL_DATA_IS_IMMUTABLE: %',
            OLD.id;
        END IF;
      END IF;

      IF OLD.status = 'posted'
         AND NEW.status NOT IN ('posted', 'reconciled', 'reversed')
      THEN
        RAISE EXCEPTION
          'INVALID_POSTED_SETTLEMENT_STATUS_TRANSITION: % -> %',
          OLD.status,
          NEW.status;
      END IF;

      IF OLD.status = 'reconciled'
         AND NEW.status NOT IN ('reconciled', 'reversed')
      THEN
        RAISE EXCEPTION
          'INVALID_RECONCILED_SETTLEMENT_STATUS_TRANSITION: % -> %',
          OLD.status,
          NEW.status;
      END IF;

      IF OLD.status = 'reversed' AND NEW.status <> 'reversed' THEN
        RAISE EXCEPTION 'REVERSED_SETTLEMENT_IS_FINAL: %', OLD.id;
      END IF;

      RETURN NEW;
    END;
    $function$;

CREATE TRIGGER trg_guard_posted_settlement_batch BEFORE UPDATE OR DELETE ON sport_center.payment_settlement_batches FOR EACH ROW EXECUTE FUNCTION sport_center.guard_posted_settlement_batch();
CREATE TRIGGER trg_guard_posted_accounting_journal BEFORE UPDATE OR DELETE ON sport_center.accounting_journals FOR EACH ROW EXECUTE FUNCTION sport_center.guard_posted_accounting_journal();
