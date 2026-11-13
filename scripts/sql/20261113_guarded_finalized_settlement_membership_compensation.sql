-- Narrow correction-only extension for posted canonical settlement membership.
-- Not a global trigger bypass: only ACTIVE -> REVERSED, unchanged other columns,
-- after a posted, linked and balanced compensating journal exists.
CREATE OR REPLACE FUNCTION sport_center.guard_finalized_settlement_items()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog','sport_center'
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
