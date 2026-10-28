-- Specify MM/DD/YYYY or DD/MM/YYYY for ambiguous slash dates on each source.
-- Leave NULL for legacy automatic detection; do not affect other bank feeds.
ALTER TABLE public.bank_sheet_configs
  ADD COLUMN IF NOT EXISTS slash_date_order text;
ALTER TABLE public.bank_sheet_configs
  DROP CONSTRAINT IF EXISTS bank_sheet_configs_slash_date_order_check;
ALTER TABLE public.bank_sheet_configs
  ADD CONSTRAINT bank_sheet_configs_slash_date_order_check
  CHECK (slash_date_order IS NULL OR slash_date_order IN ('MDY', 'DMY'));

-- Verified source: Kas Besar SC, tab 'kas besar sc', August 11 represented as 08/11/2026.
UPDATE public.bank_sheet_configs
   SET slash_date_order = 'MDY', updated_at = now()
 WHERE id = 12
   AND label = 'kas besar sc'
   AND tab_name = 'kas besar sc';
