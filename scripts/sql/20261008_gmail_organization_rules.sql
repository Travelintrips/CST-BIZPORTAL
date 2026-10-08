-- Gmail inbox organization rules
-- Creates generic per-company rules that can provision Gmail labels and filters.
create table if not exists public.gmail_organization_rules (
  id bigserial primary key,
  company_id integer not null references public.companies(id) on delete cascade,
  label_name text not null,
  from_pattern text,
  subject_pattern text,
  is_active boolean not null default true,
  gmail_label_id text,
  gmail_filter_id text,
  status text not null default 'pending',
  last_applied_at timestamptz,
  last_error text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gmail_organization_rules_match_check
    check (
      nullif(trim(coalesce(from_pattern,'')), '') is not null
      or nullif(trim(coalesce(subject_pattern,'')), '') is not null
    ),
  unique(company_id, label_name)
);

create index if not exists gmail_organization_rules_company_active_idx
  on public.gmail_organization_rules(company_id, is_active, id);

insert into public.gmail_organization_rules(
  company_id,
  label_name,
  from_pattern,
  subject_pattern,
  is_active,
  status,
  created_by,
  updated_by
)
values (
  1,
  'Hostinger',
  'hostinger.com',
  null,
  true,
  'pending',
  'chatgpt-gmail-organizer',
  'chatgpt-gmail-organizer'
)
on conflict (company_id, label_name) do update
set from_pattern = excluded.from_pattern,
    is_active = true,
    updated_at = now(),
    updated_by = excluded.updated_by;
