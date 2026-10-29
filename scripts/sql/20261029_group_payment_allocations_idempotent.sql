-- Apply only after checking existing schema and company ownership.
-- No journal changes, receipt inserts, or automatic posting.
create table if not exists sport_center.group_payment_allocations (
  id bigint generated always as identity primary key,
  payment_id integer not null,
  booking_id integer not null,
  group_ref text not null check (length(btrim(group_ref)) > 0),
  amount numeric(18,2) not null check(amount > 0),
  source_bank_mutation_id integer,
  allocation_key text not null,
  created_at timestamptz not null default now(),
  constraint group_payment_allocation_pair_uniq unique (payment_id, booking_id),
  constraint group_payment_allocation_key_uniq unique (allocation_key)
);
revoke all on sport_center.group_payment_allocations from public, anon, authenticated;
alter table sport_center.group_payment_allocations enable row level security;
comment on table sport_center.group_payment_allocations is
  'Controlled group payment allocation ledger; no payment or journal posting side effects. Writes require privileged server transaction validation.';
