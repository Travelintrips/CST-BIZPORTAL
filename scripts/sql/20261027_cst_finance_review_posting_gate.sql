-- Deployed to CST Supabase production on 2026-10-27.
-- Automatic posting is prohibited when the accounting entry has an explicit,
-- unresolved finance-document review hold. A tax PDF extracted by AI is NOT
-- a verified Faktur Pajak. Never silently clear the hold during posting.
-- This DDL applies to all companies only when governance_flags explicitly
-- specifies finance_review_required=true; unflagged normal posting is unchanged.
begin;
create or replace function public.fn_block_unreviewed_correction_post()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if old.status::text = 'draft'
     and new.status::text in ('approved','posted','pending_approval')
     and coalesce(old.governance_flags->>'finance_review_required','false')='true'
  then
    raise exception
      'FINANCE_REVIEW_REQUIRED: entry % has unresolved tax/document validation and cannot be approved or posted',
      old.entry_number using errcode='P0001';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_block_unreviewed_correction_post
 on public.accounting_entries;
create trigger trg_block_unreviewed_correction_post
before update of status on public.accounting_entries
for each row execute function public.fn_block_unreviewed_correction_post();

comment on function public.fn_block_unreviewed_correction_post() is
'Blocks draft-to-approved/posted transitions for accounting entries explicitly held for finance review. Review hold requires separately authorized, audited clearance.';
commit;

-- Verified in production: entry 33740 (JE/2026/000275) is held for
-- review with source invoice candidate 7648 and supporting candidate 7649;
-- tax verification remains pending and posting must raise
-- FINANCE_REVIEW_REQUIRED. Review the actual Faktur Pajak and tax treatment
-- through an authorized Finance workflow before clearing these flags.
-- No hardcoded trigger special case or dummy tax approval is permitted.
