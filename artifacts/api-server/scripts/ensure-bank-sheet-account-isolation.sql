-- Bank Sheet account isolation
-- Safe to run repeatedly on PostgreSQL/Supabase.

begin;

alter table public.bank_sheet_configs
  add column if not exists bank_account_id integer;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'bank_sheet_configs_bank_account_id_fkey'
       and conrelid = 'public.bank_sheet_configs'::regclass
  ) then
    alter table public.bank_sheet_configs
      add constraint bank_sheet_configs_bank_account_id_fkey
      foreign key (bank_account_id)
      references public.company_bank_accounts(id)
      on update cascade
      on delete restrict;
  end if;
end $$;

update public.bank_sheet_configs cfg
   set bank_account_id = cba.id,
       updated_at = now()
  from public.company_bank_accounts cba
 where cfg.bank_account_id is null
   and cfg.company_id = cba.company_id
   and cba.is_active = true
   and nullif(trim(cfg.bank_account_number), '') is not null
   and cba.account_number = cfg.bank_account_number;

create index if not exists bank_sheet_configs_bank_account_id_idx
  on public.bank_sheet_configs(bank_account_id);

create unique index if not exists bank_sheet_configs_company_sheet_tab_unique
  on public.bank_sheet_configs(company_id, sheet_id, tab_name)
  where company_id is not null;

create unique index if not exists company_bank_accounts_company_id_id_unique
  on public.company_bank_accounts(company_id, id);

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'bank_sheet_configs_company_account_fkey'
       and conrelid = 'public.bank_sheet_configs'::regclass
  ) then
    alter table public.bank_sheet_configs
      add constraint bank_sheet_configs_company_account_fkey
      foreign key (company_id, bank_account_id)
      references public.company_bank_accounts(company_id, id)
      on update cascade
      on delete restrict;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'bank_sheet_configs_active_requires_scope_ck'
       and conrelid = 'public.bank_sheet_configs'::regclass
  ) then
    alter table public.bank_sheet_configs
      add constraint bank_sheet_configs_active_requires_scope_ck
      check (
        is_active is not true
        or (company_id is not null and bank_account_id is not null)
      );
  end if;
end $$;

create index if not exists bank_mutations_company_account_status_date_idx
  on public.bank_mutations(company_id, bank_account_id, status, transaction_date desc);

commit;
