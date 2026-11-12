-- SC-1741 regression: reflect changes to a Sport Center booking's economic
-- terms without regenerating a payment, outbox event or accounting journal.
-- Applied and transaction-tested on Supabase CST-DEV, not PROD.
-- No historical backfill is performed here: review the booking reference first.
create or replace function sport_center.sync_booking_financial_mirrors()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, sport_center, public, pg_temp
as $$
begin
  update public.sport_bookings as mirror
     set booking_date = new.booking_date::date,
         start_time = new.start_time::time,
         end_time = new.end_time::time,
         duration_hours = new.duration_hours,
         total_amount = coalesce(new.grand_total, new.total_price),
         updated_at = now()
   where mirror.sc_booking_id = new.id
     and mirror.booking_number = new.order_number
     and (mirror.booking_date, mirror.start_time, mirror.end_time, mirror.duration_hours, mirror.total_amount)
         is distinct from
         (new.booking_date::date, new.start_time::time, new.end_time::time,
          new.duration_hours::numeric, coalesce(new.grand_total, new.total_price));

  update sport_center.sport_bookings_sync as mirror
     set "date" = new.booking_date,
         start_time = new.start_time,
         end_time = new.end_time,
         total_hours = new.duration_hours,
         total_price = coalesce(new.grand_total, new.total_price)::bigint,
         updated_at = now()
   where mirror.booking_code = new.order_number
     and (mirror."date", mirror.start_time, mirror.end_time, mirror.total_hours, mirror.total_price)
         is distinct from
         (new.booking_date, new.start_time, new.end_time, new.duration_hours::numeric,
          coalesce(new.grand_total, new.total_price)::bigint);
  return new;
end;
$$;

drop trigger if exists trg_sync_booking_financial_mirrors on sport_center.sport_bookings;
create trigger trg_sync_booking_financial_mirrors
after update of booking_date, start_time, end_time, duration_hours, total_price, grand_total
on sport_center.sport_bookings
for each row
when (
 old.booking_date is distinct from new.booking_date
 or old.start_time is distinct from new.start_time
 or old.end_time is distinct from new.end_time
 or old.duration_hours is distinct from new.duration_hours
 or old.total_price is distinct from new.total_price
 or old.grand_total is distinct from new.grand_total
)
execute function sport_center.sync_booking_financial_mirrors();
