-- Genuine CST-DEV owner function definition, copied read-only 2026-11-14.
-- Source pg_get_functiondef MD5: dea27aba38e0c66cee61d3eb43b36de0 (also matches PROD).
-- USE ONLY IN ISOLATED CI POSTGRES. No financial mutations.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE OR REPLACE FUNCTION sport_center.canonical_settlement_group_identity(p_company_id integer, p_provider_code text, p_bank_account_id text, p_settlement_date date, p_settlement_rule_version text)
 RETURNS TABLE(settlement_reference text, correlation_id text)
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'sport_center'
AS $function$
    DECLARE
      v_provider text;
      v_bank text;
      v_rule text;
      v_serialized text;
      v_digest text;
    BEGIN
      IF p_company_id IS NULL
         OR p_provider_code IS NULL
         OR btrim(p_provider_code) = ''
         OR p_bank_account_id IS NULL
         OR btrim(p_bank_account_id) = ''
         OR p_settlement_date IS NULL
         OR p_settlement_rule_version IS NULL
         OR btrim(p_settlement_rule_version) = ''
      THEN
        RAISE EXCEPTION 'CANONICAL_SETTLEMENT_GROUP_INVALID';
      END IF;

      v_provider := lower(btrim(p_provider_code));
      v_bank := btrim(p_bank_account_id);
      v_rule := btrim(p_settlement_rule_version);

      v_serialized :=
          'scb-v1|'
          || p_company_id::text
          || '|'
          || octet_length(v_provider)::text || ':' || v_provider
          || '|'
          || octet_length(v_bank)::text || ':' || v_bank
          || '|'
          || to_char(p_settlement_date, 'YYYY-MM-DD')
          || '|'
          || octet_length(v_rule)::text || ':' || v_rule;

      v_digest := encode(
        extensions.digest(convert_to(v_serialized, 'UTF8'), 'sha256'),
        'hex'
      );

      settlement_reference := 'SCB1-' || v_digest;
      correlation_id := 'scb:v1:' || v_digest;
      RETURN NEXT;
    END;
    $function$
;
