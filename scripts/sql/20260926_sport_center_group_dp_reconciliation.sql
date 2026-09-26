-- Canonical Sport Center group-payment + customer-deposit support.
-- Fixes Exso historical group payments where:
--   2026-07-24 bank IN 19,800,000 = 17,050,000 event + 2,750,000 deposit
--   2026-08-27 bank IN 18,707,800 + 2,750,000 deposit = 21,457,800 event
--
-- Historical posted journals are never deleted or rewritten financially.
-- Incorrect journals are reversed append-only, then corrected group journals are posted.

begin;

create table if not exists sport_center.customer_deposit_allocations (
  id bigserial primary key,
  company_id integer not null references public.companies(id),
  customer_name text not null,
  customer_phone text,
  source_group_ref text not null,
  target_group_ref text,
  amount numeric(18,2) not null check (amount > 0),
  source_mutation_id integer not null references public.bank_mutations(id),
  target_mutation_id integer references public.bank_mutations(id),
  status text not null default 'available'
    check (status in ('available','reserved','applied','void')),
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  applied_at timestamptz,
  constraint customer_deposit_allocations_source_unique
    unique (company_id, source_mutation_id, source_group_ref)
);

create index if not exists customer_deposit_allocations_target_group_idx
  on sport_center.customer_deposit_allocations(company_id, target_group_ref)
  where status in ('reserved','applied');

create index if not exists customer_deposit_allocations_customer_open_idx
  on sport_center.customer_deposit_allocations(company_id, lower(customer_name), status)
  where status in ('available','reserved');

comment on table sport_center.customer_deposit_allocations is
  'Canonical customer deposit ledger for Sport Center group payments. A deposit may originate as bank overpayment on one group and be applied to a later group.';

-- Seed the known Exso carry-forward deposit only where the exact canonical records exist.
insert into sport_center.customer_deposit_allocations (
  company_id, customer_name, customer_phone,
  source_group_ref, target_group_ref, amount,
  source_mutation_id, target_mutation_id,
  status, notes, created_by, applied_at
)
select
  1,
  source_group.customer_name,
  source_group.customer_phone,
  source_group.group_ref,
  target_group.group_ref,
  2750000.00,
  source_mutation.id,
  target_mutation.id,
  'applied',
  'Exso: kelebihan transfer 24 Jul 2026 dialokasikan sebagai DP event berikutnya dan digunakan pada pembayaran 27 Aug 2026.',
  'migration-20260926-exso-dp',
  timestamptz '2026-08-27 12:00:00+07'
from sport_center.booking_groups source_group
join sport_center.booking_groups target_group
  on target_group.group_ref = 'CART-MT9ROLI1-RKLA'
join public.bank_mutations source_mutation
  on source_mutation.id = 3698
 and source_mutation.company_id = 1
 and source_mutation.direction = 'IN'
 and source_mutation.amount::numeric = 19800000
join public.bank_mutations target_mutation
  on target_mutation.id = 614
 and target_mutation.company_id = 1
 and target_mutation.direction = 'IN'
 and target_mutation.amount::numeric = 18707800
where source_group.group_ref = 'CART-MRYTANG1-KO22'
  and lower(source_group.customer_name) = 'exso'
  and lower(target_group.customer_name) = 'exso'
on conflict (company_id, source_mutation_id, source_group_ref)
do update set
  target_group_ref = excluded.target_group_ref,
  target_mutation_id = excluded.target_mutation_id,
  status = 'applied',
  amount = excluded.amount,
  notes = excluded.notes,
  updated_at = now(),
  applied_at = coalesce(sport_center.customer_deposit_allocations.applied_at, excluded.applied_at);

do $repair$
declare
  v_original_id integer;
  v_reversal_id integer;
  v_source_group_id integer;
  v_target_group_id integer;
  v_journal_id integer;
  v_bank_id integer;
  v_deposit_id integer;
  v_source_mutation_amount numeric(18,2);
  v_target_mutation_amount numeric(18,2);
  v_deposit_amount numeric(18,2);
  v_credit_total numeric(18,2);
  v_corrected_id integer;
  v_target_corrected_id integer;
begin
  -- DEV may intentionally have no production transactions. In that case only
  -- the reusable schema above is installed.
  select id into v_source_group_id
    from sport_center.booking_groups
   where group_ref = 'CART-MRYTANG1-KO22'
     and lower(customer_name) = 'exso'
   order by id
   limit 1;

  select id into v_target_group_id
    from sport_center.booking_groups
   where group_ref = 'CART-MT9ROLI1-RKLA'
     and lower(customer_name) = 'exso'
   order by id
   limit 1;

  if v_source_group_id is null or v_target_group_id is null then
    return;
  end if;

  select amount::numeric into v_source_mutation_amount
    from public.bank_mutations
   where id = 3698 and company_id = 1 and direction = 'IN';

  select amount::numeric into v_target_mutation_amount
    from public.bank_mutations
   where id = 614 and company_id = 1 and direction = 'IN';

  select amount into v_deposit_amount
    from sport_center.customer_deposit_allocations
   where company_id = 1
     and source_mutation_id = 3698
     and source_group_ref = 'CART-MRYTANG1-KO22'
     and status = 'applied'
   limit 1;

  if v_source_mutation_amount is distinct from 19800000
     or v_target_mutation_amount is distinct from 18707800
     or v_deposit_amount is distinct from 2750000 then
    raise exception 'EXSO_CANONICAL_AMOUNTS_CHANGED';
  end if;

  select id into v_bank_id
    from public.chart_of_accounts
   where company_id = 1 and code = '1-1023-CST'
     and is_active = true and is_postable = true
   limit 1;

  select id into v_deposit_id
    from public.chart_of_accounts
   where company_id = 1 and code = '2-1040-CST'
     and is_active = true and is_postable = true
   limit 1;

  select journal_id into v_journal_id
    from public.accounting_entries
   where id = 28630 and company_id = 1 and status = 'posted';

  if v_bank_id is null or v_deposit_id is null or v_journal_id is null then
    raise exception 'EXSO_CORRECTION_ACCOUNT_OR_JOURNAL_MISSING';
  end if;

  -- Fail closed if the source journals do not have the exact known totals.
  if not exists (
    select 1 from public.accounting_entries
     where id = 28630 and company_id = 1 and status = 'posted'
       and total_debit::numeric = 17050000 and total_credit::numeric = 17050000
  ) then
    raise exception 'EXSO_JULY_SOURCE_JOURNAL_CHANGED';
  end if;

  if not exists (
    select 1 from public.accounting_entries
     where id = 34344 and company_id = 1 and status = 'posted'
       and total_debit::numeric = 21457800 and total_credit::numeric = 21457800
  ) then
    raise exception 'EXSO_AUGUST_SOURCE_JOURNAL_CHANGED';
  end if;

  -- Reverse every historical journal generated from duplicated group-payment rows.
  foreach v_original_id in array array[
    28630,28631,28632,28633,28634,28635,
    34344,34346,34348,34350,34352,34354,34356
  ]
  loop
    if exists (
      select 1 from public.accounting_entries
       where id = v_original_id and company_id = 1 and status = 'posted'
    ) then
      select id into v_reversal_id
        from public.accounting_entries
       where company_id = 1
         and source = 'historical_duplicate_reversal'
         and source_id = v_original_id
       limit 1;

      if v_reversal_id is null then
        insert into public.accounting_entries (
          entry_number, journal_id, date, ref, description,
          status, source, source_id,
          total_debit, total_credit,
          created_by_id, company_id,
          posted_at, entry_status,
          previous_entry_id,
          system_override, override_reason, override_by, override_at,
          governance_flags
        )
        select
          'SC-EXSO-REV/' || original.id::text,
          original.journal_id,
          original.date,
          'EXSO-DP-REV-' || original.id::text,
          'Reversal append-only koreksi group payment Exso untuk jurnal ' || original.entry_number,
          'posted',
          'historical_duplicate_reversal',
          original.id,
          original.total_credit,
          original.total_debit,
          'migration-20260926-exso-dp',
          original.company_id,
          now(),
          'POSTED',
          original.id,
          true,
          'Koreksi duplicate/group payment Exso; jurnal historis tidak dihapus.',
          'migration-20260926-exso-dp',
          now(),
          jsonb_build_object(
            'repair','exso_group_dp_20260926',
            'original_entry_id',original.id,
            'append_only',true
          )
        from public.accounting_entries original
        where original.id = v_original_id
        returning id into v_reversal_id;

        insert into public.accounting_entry_lines (
          entry_id, account_id, debit, credit, description
        )
        select
          v_reversal_id,
          line.account_id,
          line.credit,
          line.debit,
          'Reversal: ' || coalesce(line.description,'')
        from public.accounting_entry_lines line
        where line.entry_id = v_original_id
        order by line.id;
      end if;

      update public.accounting_entries
         set is_reversed = true,
             void_entry_id = coalesce(void_entry_id, v_reversal_id),
             voided_at = coalesce(voided_at, now()),
             void_reason = coalesce(void_reason, 'Reversed by Exso group-payment canonical correction'),
             voided_by = coalesce(voided_by, 'migration-20260926-exso-dp')
       where id = v_original_id;
    end if;
  end loop;

  -- Corrected canonical journal for 24 Jul:
  -- DR Bank 19.8m; CR revenue+VAT 17.05m; CR customer deposit 2.75m.
  select id into v_corrected_id
    from public.accounting_entries
   where company_id = 1
     and source = 'sport_center_group_booking'
     and source_id = v_source_group_id
   limit 1;

  if v_corrected_id is null then
    select coalesce(sum(credit),0)::numeric into v_credit_total
      from public.accounting_entry_lines
     where entry_id = 28630 and credit > 0;

    if v_credit_total + v_deposit_amount <> v_source_mutation_amount then
      raise exception 'EXSO_JULY_CORRECTION_NOT_BALANCED';
    end if;

    insert into public.accounting_entries (
      entry_number, journal_id, date, ref, description,
      status, source, source_id,
      total_debit, total_credit,
      created_by_id, company_id,
      posted_at, entry_status,
      system_override, override_reason, override_by, override_at,
      governance_flags
    )
    values (
      'SC-GRP-CANON/2026/' || lpad(v_source_group_id::text,6,'0'),
      v_journal_id,
      date '2026-07-24',
      'CART-MRYTANG1-KO22',
      'Canonical group receipt Exso: event 17.050.000 + customer deposit 2.750.000',
      'posted',
      'sport_center_group_booking',
      v_source_group_id,
      v_source_mutation_amount,
      v_source_mutation_amount,
      'migration-20260926-exso-dp',
      1,
      now(),
      'POSTED',
      true,
      'Replaces reversed duplicated Sport Center group-payment journals',
      'migration-20260926-exso-dp',
      now(),
      jsonb_build_object(
        'repair','exso_group_dp_20260926',
        'bank_mutation_id',3698,
        'deposit_created',v_deposit_amount,
        'group_ref','CART-MRYTANG1-KO22'
      )
    )
    returning id into v_corrected_id;

    insert into public.accounting_entry_lines(entry_id,account_id,debit,credit,description)
    values (
      v_corrected_id,v_bank_id,v_source_mutation_amount,0,
      'Penerimaan bank Exso 24 Jul 2026'
    );

    insert into public.accounting_entry_lines(entry_id,account_id,debit,credit,description)
    select
      v_corrected_id,
      line.account_id,
      0,
      line.credit,
      'Canonical group: ' || coalesce(line.description,'')
    from public.accounting_entry_lines line
    where line.entry_id = 28630 and line.credit > 0
    order by line.id;

    insert into public.accounting_entry_lines(entry_id,account_id,debit,credit,description)
    values (
      v_corrected_id,v_deposit_id,0,v_deposit_amount,
      'Customer deposit Exso untuk event berikutnya'
    );
  end if;

  -- Corrected canonical journal for 27 Aug:
  -- DR Bank 18.7078m + DR customer deposit 2.75m; CR revenue+VAT 21.4578m.
  select id into v_target_corrected_id
    from public.accounting_entries
   where company_id = 1
     and source = 'sport_center_group_booking'
     and source_id = v_target_group_id
   limit 1;

  if v_target_corrected_id is null then
    select coalesce(sum(credit),0)::numeric into v_credit_total
      from public.accounting_entry_lines
     where entry_id = 34344 and credit > 0;

    if v_target_mutation_amount + v_deposit_amount <> v_credit_total then
      raise exception 'EXSO_AUGUST_CORRECTION_NOT_BALANCED';
    end if;

    insert into public.accounting_entries (
      entry_number, journal_id, date, ref, description,
      status, source, source_id,
      total_debit, total_credit,
      created_by_id, company_id,
      posted_at, entry_status,
      system_override, override_reason, override_by, override_at,
      governance_flags
    )
    values (
      'SC-GRP-CANON/2026/' || lpad(v_target_group_id::text,6,'0'),
      v_journal_id,
      date '2026-08-27',
      'CART-MT9ROLI1-RKLA',
      'Canonical group receipt Exso: bank 18.707.800 + DP lama 2.750.000',
      'posted',
      'sport_center_group_booking',
      v_target_group_id,
      v_credit_total,
      v_credit_total,
      'migration-20260926-exso-dp',
      1,
      now(),
      'POSTED',
      true,
      'Replaces reversed duplicated Sport Center group-payment journals',
      'migration-20260926-exso-dp',
      now(),
      jsonb_build_object(
        'repair','exso_group_dp_20260926',
        'bank_mutation_id',614,
        'deposit_applied',v_deposit_amount,
        'group_ref','CART-MT9ROLI1-RKLA'
      )
    )
    returning id into v_target_corrected_id;

    insert into public.accounting_entry_lines(entry_id,account_id,debit,credit,description)
    values
      (v_target_corrected_id,v_bank_id,v_target_mutation_amount,0,'Penerimaan bank Exso 27 Aug 2026'),
      (v_target_corrected_id,v_deposit_id,v_deposit_amount,0,'Pemakaian customer deposit Exso');

    insert into public.accounting_entry_lines(entry_id,account_id,debit,credit,description)
    select
      v_target_corrected_id,
      line.account_id,
      0,
      line.credit,
      'Canonical group: ' || coalesce(line.description,'')
    from public.accounting_entry_lines line
    where line.entry_id = 34344 and line.credit > 0
    order by line.id;
  end if;

  -- Post-repair invariants.
  if not exists (
    select 1
      from public.accounting_entries e
     where e.id = v_corrected_id
       and e.status = 'posted'
       and e.total_debit = e.total_credit
       and e.total_debit = 19800000
  ) then
    raise exception 'EXSO_JULY_CANONICAL_JOURNAL_INVALID';
  end if;

  if not exists (
    select 1
      from public.accounting_entries e
     where e.id = v_target_corrected_id
       and e.status = 'posted'
       and e.total_debit = e.total_credit
       and e.total_debit = 21457800
  ) then
    raise exception 'EXSO_AUGUST_CANONICAL_JOURNAL_INVALID';
  end if;
end
$repair$;

commit;
