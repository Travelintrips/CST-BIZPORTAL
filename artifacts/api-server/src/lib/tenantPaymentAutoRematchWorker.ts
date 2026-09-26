import { pool } from "@workspace/db";
import { logger } from "./logger";

const INITIAL_DELAY_MS = 10_000;
const INTERVAL_MS = 60_000;
let running = false;

export async function runTenantPaymentAutoRematchOnce(): Promise<number> {
  if (running) return 0;
  running = true;
  const client = await pool.connect();
  try {
    const { rows: mutations } = await client.query<{
      id: number;
      company_id: number;
      amount: string;
      transaction_date: string;
    }>(`
      select id, company_id, amount::text, transaction_date::text
      from public.bank_mutations
      where direction = 'IN'
        and company_id is not null
        and status in ('unmatched','manual_review')
        and reconciliation_status in ('unmatched','manual_review')
        and review_code = 'RULE_NO_CANONICAL_CANDIDATE'
      order by updated_at asc
      limit 100
    `);

    let changed = 0;
    for (const mutation of mutations) {
      await client.query("begin");
      try {
        const candidates = await client.query<{
          id: number;
          business_name: string | null;
          receipt_number: string | null;
        }>(`
          select
            tp.id,
            t.business_name,
            tp.receipt_number
          from public.tenant_payments tp
          left join public.tenant_invoices ti on ti.id = tp.invoice_id
          left join public.tenants t on t.id = coalesce(tp.tenant_id, ti.tenant_id)
          where tp.company_id = $1
            and lower(coalesce(tp.status::text, '')) in ('confirmed','paid','approved','completed','success','settled')
            and nullif(to_jsonb(tp)->>'duplicate_of_payment_id', '') is null
            and lower(coalesce(tp.method::text, '')) not like '%qris%'
            and abs(tp.amount::numeric - $2::numeric) < 0.01
            and coalesce(
              (tp.paid_at at time zone 'Asia/Jakarta')::date,
              (tp.created_at at time zone 'Asia/Jakarta')::date
            ) = $3::date
            and not exists (
              select 1
              from public.bank_reconciliation_matches brm
              where brm.candidate_type = 'tenant_invoice'
                and brm.candidate_id = tp.id
                and brm.candidate_source = 'public.tenant_payments'
                and brm.status in ('approved','posted')
            )
          order by tp.id
        `, [mutation.company_id, mutation.amount, mutation.transaction_date]);

        if (candidates.rows.length === 0) {
          await client.query("rollback");
          continue;
        }

        await client.query(`
          delete from public.bank_reconciliation_matches
          where mutation_id = $1
            and status not in ('approved','posted')
            and coalesce(is_manual,false) = false
        `, [mutation.id]);

        for (const candidate of candidates.rows) {
          await client.query(`
            insert into public.bank_reconciliation_matches (
              mutation_id, candidate_type, candidate_id, match_score, match_reason,
              amount_match, date_match, name_match, order_id_match, proof_match,
              status, candidate_source, customer_name, order_ref, is_manual
            ) values (
              $1, 'tenant_invoice', $2, 85, 'Nominal dan tanggal pembayaran tenant cocok.',
              true, true, false, false, false,
              'candidate', 'public.tenant_payments', $3, $4, false
            )
          `, [mutation.id, candidate.id, candidate.business_name, candidate.receipt_number]);
        }

        const ambiguous = candidates.rows.length > 1;
        await client.query(`
          update public.bank_mutations
          set status = $1,
              reconciliation_status = $1,
              review_reason = $2,
              review_code = $3,
              updated_at = now()
          where id = $4
            and status not in ('approved_pending_posting','approved','posted','void')
        `, [
          ambiguous ? 'manual_review' : 'matched',
          ambiguous
            ? 'Lebih dari satu pembayaran tenant cocok nominal dan tanggal. Pilih kandidat yang benar.'
            : 'Nominal dan tanggal pembayaran tenant cocok.',
          ambiguous ? 'MULTIPLE_CANDIDATES' : 'LOCAL_MATCHING',
          mutation.id,
        ]);

        await client.query(`
          insert into public.bank_reconciliation_audit (mutation_id, action, actor, meta)
          values ($1, 'MATCH_CREATED', 'system:tenant-auto-rematch', $2::jsonb)
        `, [
          mutation.id,
          JSON.stringify({
            engine: 'tenant-payment-auto-rematch',
            candidate_ids: candidates.rows.map((row) => row.id),
            status: ambiguous ? 'manual_review' : 'matched',
          }),
        ]);

        await client.query("commit");
        changed++;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        logger.warn({ err: error, mutationId: mutation.id }, "[tenant-auto-rematch] mutation gagal diproses");
      }
    }
    return changed;
  } finally {
    client.release();
    running = false;
  }
}

export function startTenantPaymentAutoRematchWorker(): void {
  const tick = () => {
    void runTenantPaymentAutoRematchOnce().catch((err) => {
      logger.warn({ err }, "[tenant-auto-rematch] tick gagal");
    });
  };
  setTimeout(tick, INITIAL_DELAY_MS).unref();
  setInterval(tick, INTERVAL_MS).unref();
  logger.info({ intervalMs: INTERVAL_MS }, "[tenant-auto-rematch] worker aktif");
}
