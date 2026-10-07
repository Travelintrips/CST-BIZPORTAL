create table if not exists public.gmail_invoice_candidates (
  id bigserial primary key,
  company_id integer not null references public.companies(id) on delete cascade,
  gmail_message_id text not null,
  gmail_thread_id text,
  gmail_attachment_id text not null,
  source_email text not null,
  sender_email text,
  sender_name text,
  subject text,
  received_at timestamptz,
  attachment_file_name text not null,
  attachment_mime_type text,
  attachment_size integer,
  attachment_sha256 text,
  extracted_vendor_name text,
  extracted_invoice_number text,
  extracted_invoice_date date,
  extracted_due_date date,
  extracted_currency text,
  extracted_subtotal numeric(14,2),
  extracted_tax numeric(14,2),
  extracted_total numeric(14,2),
  extracted_confidence numeric(5,4),
  extracted_json jsonb,
  extraction_status text not null default 'pending',
  status text not null default 'new',
  vendor_invoice_id integer references public.vendor_invoices(id) on delete set null,
  error_message text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, gmail_message_id, gmail_attachment_id)
);

create index if not exists gmail_invoice_candidates_company_status_idx
  on public.gmail_invoice_candidates(company_id, status, received_at desc);

create index if not exists gmail_invoice_candidates_invoice_lookup_idx
  on public.gmail_invoice_candidates(company_id, extracted_invoice_number);

create index if not exists gmail_invoice_candidates_sha_idx
  on public.gmail_invoice_candidates(company_id, attachment_sha256)
  where attachment_sha256 is not null;
