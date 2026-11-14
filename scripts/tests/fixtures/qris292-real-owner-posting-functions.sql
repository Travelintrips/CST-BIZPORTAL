-- Exact CST-DEV owner journal posting dependencies; read-only export 2026-11-14.
-- Disposable CI PostgreSQL fixture only. Not a migration.
-- approve_accounting_journal MD5 f6b8ab33be504478179d6957089e3c78
-- is_accounting_period_locked MD5 0eefc5fb08b023426c33ad971813f5fc
-- post_accounting_journal MD5 14ceb6f46a5073426bbcd252030cf29e

CREATE OR REPLACE FUNCTION sport_center.approve_accounting_journal(p_journal_id integer, p_actor text)
 RETURNS sport_center.accounting_journals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
DECLARE
    v_journal sport_center.accounting_journals%ROWTYPE;
BEGIN

    SELECT *
      INTO v_journal
      FROM sport_center.accounting_journals
     WHERE id = p_journal_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'ACCOUNTING_JOURNAL_NOT_FOUND: %',
            p_journal_id;
    END IF;


    IF v_journal.status <> 'draft' THEN
        RAISE EXCEPTION
            'ACCOUNTING_JOURNAL_NOT_DRAFT: journal=% status=%',
            p_journal_id,
            v_journal.status;
    END IF;


    PERFORM sport_center.validate_accounting_journal(
        p_journal_id
    );


    UPDATE sport_center.accounting_journals
       SET status = 'approved',
           approved_by = p_actor,
           approved_at = now(),
           updated_at = now()
     WHERE id = p_journal_id
     RETURNING *
      INTO v_journal;


    RETURN v_journal;

END;
$function$;

CREATE OR REPLACE FUNCTION sport_center.is_accounting_period_locked(p_journal_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM sport_center.accounting_period_locks l
        WHERE l.is_locked = true
          AND p_journal_date
              BETWEEN l.period_start AND l.period_end
    );
$function$;

CREATE OR REPLACE FUNCTION sport_center.post_accounting_journal(p_journal_id integer, p_actor text)
 RETURNS sport_center.accounting_journals
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
DECLARE
    v_journal sport_center.accounting_journals%ROWTYPE;
    v_journal_date date;
BEGIN

    SELECT *
      INTO v_journal
      FROM sport_center.accounting_journals
     WHERE id = p_journal_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'ACCOUNTING_JOURNAL_NOT_FOUND: %',
            p_journal_id;
    END IF;


    IF v_journal.status <> 'approved' THEN
        RAISE EXCEPTION
            'ACCOUNTING_JOURNAL_NOT_APPROVED: journal=% status=%',
            p_journal_id,
            v_journal.status;
    END IF;


    BEGIN
        v_journal_date :=
            v_journal.journal_date::date;
    EXCEPTION WHEN others THEN
        RAISE EXCEPTION
            'INVALID_JOURNAL_DATE: journal=% value=%',
            p_journal_id,
            v_journal.journal_date;
    END;


    IF sport_center.is_accounting_period_locked(
        v_journal_date
    ) THEN
        RAISE EXCEPTION
            'ACCOUNTING_PERIOD_LOCKED: %',
            v_journal_date;
    END IF;


    PERFORM sport_center.validate_accounting_journal(
        p_journal_id
    );


    UPDATE sport_center.accounting_journals
       SET status = 'posted',
           posted_by = p_actor,
           posted_at = now(),
           updated_at = now()
     WHERE id = p_journal_id
     RETURNING *
      INTO v_journal;


    RETURN v_journal;

END;
$function$;
