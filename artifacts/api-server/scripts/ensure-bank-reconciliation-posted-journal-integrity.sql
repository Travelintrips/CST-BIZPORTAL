-- Bank reconciliation journal integrity guard.
-- Production was repaired on 2026-09-20 before these constraints were validated.
-- These constraints are intentionally declarative (no application-owned trigger).

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.bank_mutations'::regclass
       and conname = 'bank_mutations_posted_requires_journal_ck'
  ) then
    alter table public.bank_mutations
      add constraint bank_mutations_posted_requires_journal_ck
      check (status <> 'posted' or journal_entry_id is not null)
      not valid;
  end if;
end $$;

alter table public.bank_mutations
  validate constraint bank_mutations_posted_requires_journal_ck;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.bank_mutations'::regclass
       and conname = 'bank_mutations_journal_entry_id_fkey'
  ) then
    alter table public.bank_mutations
      add constraint bank_mutations_journal_entry_id_fkey
      foreign key (journal_entry_id)
      references public.accounting_entries(id)
      on delete restrict
      not valid;
  end if;
end $$;

alter table public.bank_mutations
  validate constraint bank_mutations_journal_entry_id_fkey;

-- Expected after validation:
--   1) no bank mutation can be marked posted without a linked journal;
--   2) a linked accounting entry cannot be deleted while the mutation references it.
