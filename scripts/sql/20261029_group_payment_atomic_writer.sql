-- Apply after group_payment_allocations table migration. Privileged DB operation.
-- Never posts receipts, journals, or alters original payment records.
create or replace function sport_center.allocate_group_payment(p_payment_id integer,p_group_ref text)
returns table(booking_id integer, allocated_amount numeric, was_inserted boolean)
language plpgsql security invoker set search_path=sport_center,pg_temp as $fn$
#variable_conflict use_column
declare v_payment record; v_total numeric; v_count integer;
begin
 if p_group_ref is null or btrim(p_group_ref)='' then raise exception 'GROUP_REQUIRED'; end if;
 perform pg_advisory_xact_lock(8142026,p_payment_id);
 select * into v_payment from sport_center.sport_payments where id=p_payment_id for update;
 if not found or v_payment.status::text <> 'confirmed'
 or lower(btrim(v_payment.payment_method)) not in ('transfer bank','transfer')
 then raise exception 'CONFIRMED_BANK_TRANSFER_REQUIRED'; end if;
 if not exists(select 1 from sport_center.sport_bookings where id=v_payment.booking_id and group_ref=p_group_ref)
 then raise exception 'PAYMENT_BOOKING_OUTSIDE_GROUP'; end if;
 select sum(total_price),count(*) into v_total,v_count from sport_center.sport_bookings
 where group_ref=p_group_ref and status::text<>'cancelled';
 if v_count<1 or v_total is distinct from v_payment.amount then raise exception 'GROUP_TOTAL_MISMATCH'; end if;
 if exists(select 1 from sport_center.group_payment_allocations a
 where a.payment_id=p_payment_id and
 (a.group_ref<>p_group_ref or a.booking_id not in (select b.id from sport_center.sport_bookings b where b.group_ref=p_group_ref)
 or a.amount is distinct from (select b.total_price from sport_center.sport_bookings b where b.id=a.booking_id)))
 then raise exception 'EXISTING_ALLOCATION_CONFLICT'; end if;
 if exists(select 1 from sport_center.group_payment_allocations a
 where a.booking_id in (select b.id from sport_center.sport_bookings b where b.group_ref=p_group_ref)
 and a.payment_id<>p_payment_id) then raise exception 'BOOKING_ALLOCATED_OTHER_PAYMENT'; end if;
 return query
 with ins as (
 insert into sport_center.group_payment_allocations(payment_id,booking_id,group_ref,amount,allocation_key)
 select p_payment_id,b.id,p_group_ref,b.total_price,p_payment_id::text||':'||b.id::text
 from sport_center.sport_bookings b where b.group_ref=p_group_ref and b.status::text<>'cancelled'
 on conflict on constraint group_payment_allocation_pair_uniq do nothing
 returning sport_center.group_payment_allocations.booking_id)
 select b.id,b.total_price,ins.booking_id is not null
 from sport_center.sport_bookings b left join ins on ins.booking_id=b.id
 where b.group_ref=p_group_ref and b.status::text<>'cancelled' order by b.id;
end $fn$;
revoke all on function sport_center.allocate_group_payment(integer,text) from public,anon,authenticated;
