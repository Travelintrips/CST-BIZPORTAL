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

commit;
