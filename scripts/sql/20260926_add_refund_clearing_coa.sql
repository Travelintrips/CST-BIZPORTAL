-- 2026-09-26
-- Dedicated temporary clearing COAs for refund/pengembalian dana in CST (company_id = 1).
--
-- Design:
--   REFUND OUT / uang keluar:
--     DR 1-1110-CST Kliring Pengembalian Dana Keluar CST
--     CR Bank
--   REFUND IN / uang masuk:
--     DR Bank
--     CR 2-1110-CST Kliring Pengembalian Dana Masuk CST
--
-- These are temporary balance-sheet clearing accounts. When the source
-- transaction is identified, reclassify the clearing balance to the original
-- customer/vendor/advance/expense/revenue account instead of recognizing a new
-- P&L item.

begin;

insert into public.chart_of_accounts (
  code,
  name,
  type,
  parent_id,
  is_active,
  company_id,
  account_type,
  subtype,
  normal_balance,
  account_category,
  is_postable,
  is_header,
  status,
  version,
  created_by,
  updated_by
)
select
  '1-1110-CST',
  'Kliring Pengembalian Dana Keluar CST',
  'asset',
  p.id,
  true,
  1,
  'asset',
  'refund_clearing_out',
  'DEBIT',
  'ASSET',
  true,
  false,
  'ACTIVE',
  1,
  'refund-clearing-coa-20260926',
  'refund-clearing-coa-20260926'
from public.chart_of_accounts p
where p.code = '1-1000'
  and p.company_id is null
  and coalesce(p.is_header, false) = true
  and not exists (
    select 1
    from public.chart_of_accounts c
    where c.company_id = 1
      and c.code = '1-1110-CST'
  )
limit 1;

insert into public.chart_of_accounts (
  code,
  name,
  type,
  parent_id,
  is_active,
  company_id,
  account_type,
  subtype,
  normal_balance,
  account_category,
  is_postable,
  is_header,
  status,
  version,
  created_by,
  updated_by
)
select
  '2-1110-CST',
  'Kliring Pengembalian Dana Masuk CST',
  'liability',
  p.id,
  true,
  1,
  'liability',
  'refund_clearing_in',
  'CREDIT',
  'LIABILITY',
  true,
  false,
  'ACTIVE',
  1,
  'refund-clearing-coa-20260926',
  'refund-clearing-coa-20260926'
from public.chart_of_accounts p
where p.code = '2-1000'
  and p.company_id is null
  and coalesce(p.is_header, false) = true
  and not exists (
    select 1
    from public.chart_of_accounts c
    where c.company_id = 1
      and c.code = '2-1110-CST'
  )
limit 1;

do $$
begin
  if not exists (
    select 1 from public.chart_of_accounts
    where company_id = 1
      and code = '1-1110-CST'
      and account_category = 'ASSET'
      and normal_balance = 'DEBIT'
      and is_active = true
      and is_postable = true
  ) then
    raise exception 'REFUND_OUT_COA_NOT_READY';
  end if;

  if not exists (
    select 1 from public.chart_of_accounts
    where company_id = 1
      and code = '2-1110-CST'
      and account_category = 'LIABILITY'
      and normal_balance = 'CREDIT'
      and is_active = true
      and is_postable = true
  ) then
    raise exception 'REFUND_IN_COA_NOT_READY';
  end if;
end
$$;

commit;
