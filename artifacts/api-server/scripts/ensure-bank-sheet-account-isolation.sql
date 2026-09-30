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

create unique index if not exists bank_sheet_configs_one_active_per_account
  on public.bank_sheet_configs(company_id, bank_account_id)
  where is_active = true
    and company_id is not null
    and bank_account_id is not null;

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

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'bank_mutations_sheet_config_id_fkey'
       and conrelid = 'public.bank_mutations'::regclass
  ) then
    alter table public.bank_mutations
      add constraint bank_mutations_sheet_config_id_fkey
      foreign key (sheet_config_id)
      references public.bank_sheet_configs(id)
      on update cascade
      on delete restrict
      not valid;
    alter table public.bank_mutations
      validate constraint bank_mutations_sheet_config_id_fkey;
  end if;
end $$;

create or replace function public.enforce_google_sheet_mutation_scope()
returns trigger
language plpgsql
as $$
declare
  cfg_company_id integer;
  cfg_bank_account_id integer;
begin
  if coalesce(new.source, '') <> 'google_sheet' then
    return new;
  end if;

  if new.sheet_config_id is null
     or new.company_id is null
     or nullif(trim(new.bank_account_id::text), '') is null then
    raise exception
      'Google Sheet mutation requires sheet_config_id, company_id, and bank_account_id';
  end if;

  select cfg.company_id, cfg.bank_account_id
    into cfg_company_id, cfg_bank_account_id
    from public.bank_sheet_configs cfg
   where cfg.id = new.sheet_config_id;

  if not found then
    raise exception 'Google Sheet mutation references missing sheet config %', new.sheet_config_id;
  end if;

  if new.company_id is distinct from cfg_company_id
     or new.bank_account_id::text is distinct from cfg_bank_account_id::text then
    raise exception
      'Google Sheet mutation scope mismatch: config %, company %/% account %/%',
      new.sheet_config_id,
      new.company_id,
      cfg_company_id,
      new.bank_account_id,
      cfg_bank_account_id;
  end if;

  return new;
end $$;

drop trigger if exists trg_enforce_google_sheet_mutation_scope
  on public.bank_mutations;

create trigger trg_enforce_google_sheet_mutation_scope
before insert or update of source, sheet_config_id, company_id, bank_account_id
on public.bank_mutations
for each row
execute function public.enforce_google_sheet_mutation_scope();

commit;
