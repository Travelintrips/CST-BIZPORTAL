-- SECURITY DEFINER functions are server-internal unless explicitly re-granted.
-- Backend settlement flows use direct PostgreSQL connections, not browser RPC.

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure::text as fn
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where p.prosecdef
      and n.nspname in ('public','sport_center')
  loop
    execute 'revoke execute on function ' || r.fn || ' from public, anon, authenticated';
  end loop;
end $$;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema sport_center
  revoke execute on functions from public, anon, authenticated;
