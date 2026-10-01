-- Scope legacy Rule AI rows to the reconciliation account that originally
-- produced them.  Existing CST rules pre-date account isolation and were all
-- learned from the Mandiri Ciputat mutation feed.  Kas Besar SC starts with
-- its own independent rule set and learns only from that account going forward.

do $$
declare
  v_company_id integer := 1;
  v_mandiri_account_id integer;
begin
  select config.bank_account_id
    into v_mandiri_account_id
    from public.bank_sheet_configs config
    left join public.company_bank_accounts account
      on account.id = config.bank_account_id
   where config.company_id = v_company_id
     and config.is_active = true
     and (
       lower(trim(config.label)) = 'mandiri ciputat'
       or lower(trim(config.tab_name)) = 'mutasi ciputat'
       or lower(trim(coalesce(account.name, ''))) = 'bank mandiri ciputat'
     )
   order by config.id desc
   limit 1;

  if v_mandiri_account_id is null then
    raise exception 'Mandiri Ciputat reconciliation account was not found for company %', v_company_id;
  end if;

  update public.recon_rules
     set bank_account_id = v_mandiri_account_id,
         updated_at = now()
   where company_id = v_company_id
     and bank_account_id is null;
end
$$;

-- Verification:
-- select bank_account_id, count(*)
-- from public.recon_rules
-- where company_id = 1
-- group by bank_account_id
-- order by bank_account_id;
