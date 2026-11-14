import { sql } from "drizzle-orm";
// Runtime writer is deliberately unexposed until full finance E2E has passed.
type DbClient = typeof import("@workspace/db").db;

export type CanonicalSettlementCorrectionInput = {
  settlementId: number;
  expectedBankMutationId: number;
  replacementPaymentIds: number[];
  actor: string;
  reason: string;
};

export type CanonicalSettlementCorrectionResult = {
  ok: true;
  idempotent: boolean;
  settlementId: number;
  reversedSettlementJournalId: number;
  replacementPaymentIds: number[];
  bankMutationId: number | null;
  settlementStatus: "reversed";
  bankMutationStatus: "unmatched" | "unchanged";
};

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll(`"`, `""`)}"`;
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

function asPositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("ID harus berupa bilangan bulat positif.");
  }
  return parsed;
}

/**
 * Reverse a canonical settlement whose payment membership was wrong.
 *
 * This is deliberately a correction boundary, not a generic "edit posted"
 * helper:
 * - the original posted journal is never updated or deleted;
 * - a balanced reversal journal is copied from its exact lines;
 * - all state changes are serialized in one transaction;
 * - the replacement selection is recorded but not auto-approved.
 *
 * The caller can subsequently run the normal canonical builder and approval
 * workflow with the returned replacement IDs. Keeping those steps separate
 * prevents an incomplete replacement from silently becoming a settlement.
 */
export async function reverseCanonicalSettlementForCorrection(
  client: DbClient,
  input: CanonicalSettlementCorrectionInput,
): Promise<CanonicalSettlementCorrectionResult> {
  const settlementId = asPositiveInt(input.settlementId);
  const expectedBankMutationId = asPositiveInt(input.expectedBankMutationId);
  const rawReplacementPaymentIds = input.replacementPaymentIds.map(asPositiveInt);
  const replacementPaymentIds = [...new Set(rawReplacementPaymentIds)];
  const actor = String(input.actor ?? "").trim();
  const reason = String(input.reason ?? "").trim();

  if (!actor) throw new Error("Actor correction wajib diisi.");
  if (reason.length < 10 || reason.length > 2000) {
    throw new Error("Alasan correction wajib diisi antara 10 dan 2000 karakter.");
  }
  if (replacementPaymentIds.length === 0) {
    throw new Error("Replacement payment wajib diisi.");
  }
  if (replacementPaymentIds.length !== rawReplacementPaymentIds.length) {
    throw new Error("Replacement payment tidak boleh memuat ID duplikat.");
  }

  return client.transaction(async (tx) => {
    const batchResult = await tx.execute(sql`
      SELECT
        id, company_id, status::text AS status, bank_mutation_id,
        canonical_bank_mutation_id, settlement_journal_id
      FROM sport_center.payment_settlement_batches
      WHERE id = ${settlementId}
      FOR UPDATE
    `);
    const batch = batchResult.rows[0] as Record<string, unknown> | undefined;
    if (!batch) throw new Error(`Settlement canonical #${settlementId} tidak ditemukan.`);

    const batchStatus = String(batch.status ?? "").toLowerCase();
    const bankMutationId = batch.bank_mutation_id == null
      ? null
      : asPositiveInt(batch.bank_mutation_id);
    const journalId = asPositiveInt(batch.settlement_journal_id);
    const postedUnlinked = batchStatus === "posted"
      && bankMutationId === null && batch.canonical_bank_mutation_id == null;
    const correctionBankMutationId = postedUnlinked ? expectedBankMutationId : bankMutationId;

    const reversalResult = await tx.execute(sql`
      SELECT id
      FROM sport_center.accounting_journals
      WHERE settlement_batch_id::text = ${String(settlementId)}
        AND journal_type = 'settlement'
        AND is_reversal = TRUE
        AND status = 'posted'
        AND notes LIKE ${`%CANONICAL_MEMBERSHIP_CORRECTION:${settlementId}%`}
        AND reversal_of_id = ${journalId}
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
    `);
    const existingReversal = reversalResult.rows[0] as Record<string, unknown> | undefined;
    if (existingReversal) {
      if (batchStatus !== "reversed") {
        throw new Error("Posted reversal exists but original settlement is not reversed.");
      }
      // Never report a repeated correction as idempotent when the caller has
      // changed the requested bank identity or replacement payment set.
      const correctionAudit = await tx.execute(sql`
        SELECT mutation_id,meta
        FROM public.bank_reconciliation_audit
        WHERE action='CANONICAL_SETTLEMENT_MEMBERSHIP_CORRECTION_REVERSED'
          AND (meta->>'settlement_id')::bigint=${settlementId}
          AND (meta->>'reversal_settlement_journal_id')::integer=${asPositiveInt(existingReversal.id)}
        ORDER BY id DESC LIMIT 1
      `);
      const recorded = correctionAudit.rows[0] as Record<string, unknown> | undefined;
      const meta = recorded?.meta as Record<string, unknown> | undefined;
      const originalReplacementIds = Array.isArray(meta?.replacement_payment_ids)
        ? meta.replacement_payment_ids.map(Number).sort((a,b)=>a-b)
        : [];
      if (!recorded || Number(recorded.mutation_id) !== expectedBankMutationId
        || originalReplacementIds.join(",") !== [...replacementPaymentIds].sort((a,b)=>a-b).join(",")) {
        throw new Error("Idempotent reversal request does not match the audited original correction.");
      }
      return {
        ok: true,
        idempotent: true,
        settlementId,
        reversedSettlementJournalId: asPositiveInt(existingReversal.id),
        replacementPaymentIds,
        bankMutationId: expectedBankMutationId,
        settlementStatus: "reversed",
        bankMutationStatus: "unmatched",
      };
    }

    if (!postedUnlinked) {
      if (batchStatus !== "reconciled" ||
          bankMutationId == null || batch.canonical_bank_mutation_id == null) {
        throw new Error("Batch harus reconciled/linked atau posted/unlinked.");
      }
      if (bankMutationId !== expectedBankMutationId ||
          asPositiveInt(batch.canonical_bank_mutation_id) !== bankMutationId) {
        throw new Error("Link bank canonical berbeda dengan mutation koreksi.");
      }
    }

    const journalResult = await tx.execute(sql`
      SELECT *
      FROM sport_center.accounting_journals
      WHERE id = ${journalId}
      FOR UPDATE
    `);
    const journal = journalResult.rows[0] as Record<string, unknown> | undefined;
    if (
      !journal
      || String(journal.status ?? "").toLowerCase() !== "posted"
      || String(journal.journal_type ?? "").toLowerCase() !== "settlement"
      || journal.is_reversal !== false
      || asPositiveInt(journal.settlement_batch_id) !== settlementId
    ) {
      throw new Error(
        "Settlement journal tidak eligible: harus posted, settlement, non-reversal, dan menunjuk batch yang sama.",
      );
    }

    // #292 historical journal must match the exact verified bank, MDR and
    // clearing structure before any reversal is inserted. Merely being posted
    // and balanced is insufficient when a wrong COA could also balance.
    if (postedUnlinked && settlementId === 5738) {
      const sourceLines = await tx.execute(sql`
        SELECT COUNT(*)::integer AS lines,
          COALESCE(SUM(amount) FILTER (WHERE line_type='debit'),0) AS debit_total,
          COALESCE(SUM(amount) FILTER (WHERE line_type='credit'),0) AS credit_total,
          COALESCE(SUM(amount) FILTER (
            WHERE line_type='debit' AND account_code='1-1023-CST'),0) AS bank_debit,
          COALESCE(SUM(amount) FILTER (
            WHERE line_type='debit' AND account_code='5-3050-CST'),0) AS mdr_debit,
          COALESCE(SUM(amount) FILTER (
            WHERE line_type='credit' AND account_code='1-1024-CST'),0) AS clearing_credit
        FROM sport_center.accounting_journal_lines
        WHERE journal_id=${journalId}
      `);
      const evidence=sourceLines.rows[0] as Record<string,unknown>|undefined;
      if (!evidence || Number(evidence.lines)!==3
        || Number(evidence.debit_total)!==930000
        || Number(evidence.credit_total)!==930000
        || Number(evidence.bank_debit)!==923700
        || Number(evidence.mdr_debit)!==6300
        || Number(evidence.clearing_credit)!==930000) {
        throw new Error("Issue #292 source journal #7207 bank/MDR/clearing structure has changed.");
      }
    }

    const activeItemsResult = await tx.execute(sql`
      SELECT payment_id
      FROM sport_center.payment_settlement_items
      WHERE settlement_id = ${settlementId}
        AND item_status = 'active'
      ORDER BY payment_id
      FOR UPDATE
    `);
    if (activeItemsResult.rows.length === 0) {
      throw new Error("Batch canonical tidak memiliki active payment item.");
    }

    if (postedUnlinked) {
      // A compensating correction is valid only for a genuinely invalid
      // historical membership. Do not reverse an otherwise valid posted batch.
      const originalEvidence = await tx.execute(sql`
        SELECT
          COUNT(*)::integer AS member_count,
          COUNT(*) FILTER (WHERE p.id IS NULL
            OR p.paid_at IS NULL
            OR (p.paid_at AT TIME ZONE 'Asia/Jakarta')::date + 1
                IS DISTINCT FROM b.settlement_date)::integer AS wrong_date_count,
          COALESCE(SUM(p.amount),0)::numeric AS source_gross,
          COALESCE(SUM(p.mdr_amount),0)::numeric AS source_mdr
        FROM sport_center.payment_settlement_items i
        JOIN sport_center.payment_settlement_batches b ON b.id=i.settlement_id
        LEFT JOIN sport_center.sport_payments p ON p.id=i.payment_id
        WHERE i.settlement_id=${settlementId} AND i.item_status='active'
      `);
      const original = originalEvidence.rows[0] as Record<string, unknown> | undefined;
      if (!original || Number(original.member_count) !== activeItemsResult.rows.length
        || Number(original.wrong_date_count) < 1) {
        throw new Error("Posted settlement must contain a real H+1-invalid member before correction.");
      }
    }

    const paymentIdList = replacementPaymentIds.join(",");
    const replacementResult = await tx.execute(sql.raw(`
      SELECT
        p.id,
        p.company_id,
        p.amount,
        p.mdr_amount,
        p.status::text AS payment_status,
        p.settlement_status::text AS settlement_status,
        p.payment_method::text AS payment_method,
        p.payment_provider::text AS payment_provider,
        p.bank_account_id::text AS bank_account_id,
        p.paid_at,
        p.expected_settlement_date::text AS expected_settlement_date,
        p.settlement_rule_version
      FROM sport_center.sport_payments p
      WHERE p.id IN (${paymentIdList})
      ORDER BY p.id
      FOR UPDATE
    `));
    if (replacementResult.rows.length !== replacementPaymentIds.length) {
      throw new Error("Satu atau lebih replacement payment tidak ditemukan.");
    }
    if (postedUnlinked) {
      const oldTotals = await tx.execute(sql`
        SELECT COUNT(*)::integer AS payment_count,
               COALESCE(SUM(gross_amount),0)::numeric AS gross_amount
        FROM sport_center.payment_settlement_items
        WHERE settlement_id=${settlementId} AND item_status='active'
      `);
      const old = oldTotals.rows[0] as Record<string,unknown> | undefined;
      const newGrossCents = replacementResult.rows.reduce(
        (sum,row) => sum + Math.round(Number((row as Record<string,unknown>).amount) * 100),0);
      const newMdrCents = replacementResult.rows.reduce(
        (sum,row) => sum + Math.round(Number((row as Record<string,unknown>).mdr_amount) * 100),0);
      const totals = await tx.execute(sql`
        SELECT gross_amount, mdr_amount, net_amount
        FROM sport_center.payment_settlement_batches WHERE id=${settlementId}
      `);
      const amounts = totals.rows[0] as Record<string,unknown> | undefined;
      if (!amounts
        || replacementPaymentIds.length !== Number(old?.payment_count)
        || newGrossCents !== Math.round(Number(old?.gross_amount) * 100)
        || newGrossCents !== Math.round(Number(amounts.gross_amount) * 100)
        || newMdrCents !== Math.round(Number(amounts.mdr_amount) * 100)
        || newGrossCents - newMdrCents !== Math.round(Number(amounts.net_amount) * 100)) {
        throw new Error("Replacement cohort gross/MDR/net or member count does not match posted settlement.");
      }
    }

    const batchCompanyId = Number(batch.company_id);
    const batchDateResult = await tx.execute(sql`
      SELECT settlement_date::text AS settlement_date,
             lower(provider_code) AS provider_code,
             bank_account_id::text AS bank_account_id,
             settlement_rule_version
      FROM sport_center.payment_settlement_batches
      WHERE id = ${settlementId}
    `);
    const identity = batchDateResult.rows[0] as Record<string, unknown> | undefined;
    if (!identity) throw new Error("Identitas settlement tidak ditemukan.");

    for (const row of replacementResult.rows as Array<Record<string, unknown>>) {
      if (
        Number(row.company_id) !== batchCompanyId
        || String(row.payment_status ?? "").toLowerCase() !== "confirmed"
        || !String(row.payment_method ?? "").toLowerCase().includes("qris")
        || String(row.expected_settlement_date ?? "").slice(0, 10)
          !== String(identity.settlement_date ?? "").slice(0, 10)
        || row.paid_at == null
        || String(row.paid_at).slice(0, 10) === ""
        || String(row.settlement_rule_version ?? "") !== String(identity.settlement_rule_version ?? "")
        || String(row.payment_provider ?? "").toLowerCase() !== String(identity.provider_code ?? "").toLowerCase()
        || String(row.bank_account_id ?? "") !== String(identity.bank_account_id ?? "")
      ) {
        throw new Error(
          `Replacement payment ${row.id} tidak cocok dengan company/provider/rekening/tanggal/rule batch.`,
        );
      }
    }
    const hMinusOneResult = await tx.execute(sql.raw(`
      SELECT COUNT(*)::int AS invalid_count
      FROM sport_center.sport_payments
      WHERE id IN (${paymentIdList})
        AND (
          paid_at IS NULL
          OR ((paid_at AT TIME ZONE 'Asia/Jakarta')::date + 1)
             <> (
               SELECT settlement_date::date
               FROM sport_center.payment_settlement_batches
               WHERE id = ${settlementId}
             )
        )
    `));
    if (Number((hMinusOneResult.rows[0] as Record<string, unknown>)?.invalid_count ?? 0) !== 0) {
      throw new Error("Replacement payment harus memenuhi aturan H-1 terhadap settlement batch.");
    }

    const conflictsResult = await tx.execute(sql.raw(`
      SELECT i.payment_id, i.settlement_id
      FROM sport_center.payment_settlement_items i
      JOIN sport_center.payment_settlement_batches b
        ON b.id = i.settlement_id
      WHERE i.payment_id IN (${paymentIdList})
        AND i.item_status = 'active'
        AND i.settlement_id <> ${settlementId}
        AND b.status IN ('draft', 'calculated', 'posted', 'reconciled')
      LIMIT 1
      FOR UPDATE OF i, b
    `));
    if (conflictsResult.rows.length > 0) {
      const conflict = conflictsResult.rows[0] as Record<string, unknown>;
      throw new Error(
        `Replacement payment ${conflict.payment_id} sudah aktif di settlement #${conflict.settlement_id}.`,
      );
    }

    const publicMutationResult = await tx.execute(sql`
      SELECT id, status, journal_entry_id
      FROM public.bank_mutations
      WHERE id = ${correctionBankMutationId}
      FOR UPDATE
    `);
    const publicMutation = publicMutationResult.rows[0] as Record<string, unknown> | undefined;
    if (!publicMutation) throw new Error(`Mutasi bank #${correctionBankMutationId} tidak ditemukan.`);
    if (publicMutation.journal_entry_id != null) {
      throw new Error("Mutasi bank memiliki journal generic; correction dihentikan.");
    }
    if (!["approved", "matched", "auto_matched"].includes(
      String(publicMutation.status ?? "").toLowerCase(),
    )) {
      throw new Error("Status mutasi bank berubah; correction dihentikan.");
    }
    if (postedUnlinked) {
      const bankIdentity = await tx.execute(sql`
        SELECT m.id,m.company_id,m.amount,m.transaction_date::text AS transaction_date,
               m.source_classification,m.direction,m.approved_at,m.posted_at,
               a.account_number,a.company_id AS account_company_id,a.is_active
        FROM public.bank_mutations m
        JOIN public.company_bank_accounts a ON a.id::text=m.bank_account_id
        WHERE m.id=${correctionBankMutationId}
      `);
      const bank = bankIdentity.rows[0] as Record<string, unknown> | undefined;
      if (!bank || bank.source_classification !== "actual_bank_mutation"
        || bank.direction !== "IN" || bank.approved_at != null || bank.posted_at != null
        || bank.is_active !== true
        || Number(bank.company_id) !== Number(batch.company_id)
        || Number(bank.account_company_id) !== Number(batch.company_id)
        || String(bank.account_number) !== String(identity.bank_account_id)
        || String(bank.transaction_date).slice(0,10) !== String(identity.settlement_date).slice(0,10)) {
        throw new Error("Posted/unlinked correction requires an unapproved bank mutation with matching owner/date.");
      }
      const originalFinancials = await tx.execute(sql`
        SELECT net_amount FROM sport_center.payment_settlement_batches
        WHERE id=${settlementId}
      `);
      if (Number(bank.amount) !== Number((originalFinancials.rows[0] as Record<string,unknown>).net_amount)) {
        throw new Error("Posted/unlinked correction net amount does not match bank.");
      }
    }

    const matchResult = await tx.execute(sql`
      SELECT id, candidate_id, candidate_source, status
      FROM public.bank_reconciliation_matches
      WHERE mutation_id = ${correctionBankMutationId}
        AND candidate_type = 'qris_settlement'
        AND candidate_id::text = ${String(settlementId)}
        AND candidate_source = 'sport_center.payment_settlement_batches'
        AND status IN ('approved', 'candidate')
      ORDER BY id
      LIMIT 2
      FOR UPDATE
    `);
    if (matchResult.rows.length !== 1) {
      throw new Error("Canonical bank match tidak tunggal untuk batch correction.");
    }

    // Clone the journal using the live catalog so this remains compatible with
    // additive columns in the Sport Center accounting schema. The original
    // posted row is never updated.
    const columnsResult = await tx.execute(sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'sport_center'
        AND table_name = 'accounting_journals'
        AND column_name <> 'id'
        AND is_generated = 'NEVER'
        AND is_identity = 'NO'
      ORDER BY ordinal_position
    `);
    const columns = (columnsResult.rows as Array<Record<string, unknown>>)
      .map((row) => String(row.column_name))
      .filter((column) => column !== "created_at" && column !== "updated_at");
    if (!columns.includes("status") || !columns.includes("is_reversal")) {
      throw new Error("Schema accounting journal tidak memiliki kolom reversal yang diperlukan.");
    }
    const selectExpressions = columns.map((column) => {
      if (column === "status") return `'draft' AS ${quoteIdentifier(column)}`;
      if (column === "is_reversal") return `TRUE AS ${quoteIdentifier(column)}`;
      if (column === "reversal_of_id") return `${journalId} AS ${quoteIdentifier(column)}`;
      if (column === "correlation_id") {
        return `'canonical-membership-reversal:${settlementId}:${journalId}' AS ${quoteIdentifier(column)}`;
      }
      if (column === "settlement_reference" || column === "source_event_id"
        || column === "posted_at" || column === "posted_by"
        || column === "approved_at" || column === "approved_by") {
        return `NULL AS ${quoteIdentifier(column)}`;
      }
      if (column === "settlement_status") return `'reversed' AS ${quoteIdentifier(column)}`;
      if (column === "notes") {
        return `COALESCE(${quoteIdentifier(column)}, '') || ' CANONICAL_MEMBERSHIP_CORRECTION:${settlementId}' AS ${quoteIdentifier(column)}`;
      }
      if (column === "created_by") return `'${escapeSql(actor)}' AS ${quoteIdentifier(column)}`;
      return quoteIdentifier(column);
    }).join(", ");
    const columnList = columns.map(quoteIdentifier).join(", ");
    const reversalInsert = await tx.execute(sql.raw(`
      INSERT INTO sport_center.accounting_journals (${columnList})
      SELECT ${selectExpressions}
      FROM sport_center.accounting_journals
      WHERE id = ${journalId}
      RETURNING id
    `));
    const reversalJournalId = asPositiveInt(
      (reversalInsert.rows[0] as Record<string, unknown> | undefined)?.id,
    );

    await tx.execute(sql.raw(`
      INSERT INTO sport_center.accounting_journal_lines
        (journal_id, line_type, account_code, account_name, amount, description)
      SELECT
        ${reversalJournalId},
        CASE WHEN line_type = 'debit' THEN 'credit' ELSE 'debit' END,
        account_code,
        account_name,
        amount,
        'REVERSAL CANONICAL MEMBERSHIP CORRECTION: ' || COALESCE(description, '')
      FROM sport_center.accounting_journal_lines
      WHERE journal_id = ${journalId}
    `));
    await tx.execute(sql`
      SELECT sport_center.validate_accounting_journal(${reversalJournalId})
    `);
    await tx.execute(sql`
      UPDATE sport_center.accounting_journals
      SET status = 'posted'
      WHERE id = ${reversalJournalId}
        AND status = 'draft'
    `);

    // The original batch must be reversed before its protected item statuses
    // can be changed. The item trigger then independently requires a posted,
    // balanced reversal linked to the exact original settlement journal.
    const reversedBatch = await tx.execute(sql`
      UPDATE sport_center.payment_settlement_batches
         SET status='reversed',
             bank_mutation_id=NULL,
             canonical_bank_mutation_id=NULL,
             updated_at=NOW()
       WHERE id=${settlementId}
         AND ((status='reconciled'
               AND bank_mutation_id=${correctionBankMutationId}
               AND canonical_bank_mutation_id=${correctionBankMutationId})
           OR (status='posted'
               AND bank_mutation_id IS NULL
               AND canonical_bank_mutation_id IS NULL))
       RETURNING id
    `);
    if (reversedBatch.rows.length !== 1) {
      throw new Error("Settlement status changed before correction commit.");
    }
    await tx.execute(sql`
      SELECT set_config('sport_center.allow_finalized_membership_reversal',
                        'owner-audited-compensation-v1',true)
    `);
    const reversedItems = await tx.execute(sql`
      UPDATE sport_center.payment_settlement_items
         SET item_status='reversed'
       WHERE settlement_id=${settlementId} AND item_status='active'
       RETURNING payment_id
    `);
    if (reversedItems.rows.length !== activeItemsResult.rows.length) {
      throw new Error("Compensation item count mismatch.");
    }
    await tx.execute(sql`
      SELECT set_config('sport_center.allow_posted_payment_metadata_correction','on',true)
    `);
    await tx.execute(sql`
      SELECT set_config('sport_center.allow_posted_accounting_metadata_correction','on',true)
    `);
    await tx.execute(sql`
      UPDATE sport_center.sport_payments p
         SET settlement_status='unsettled', updated_at=NOW()
       WHERE p.id IN (
         SELECT DISTINCT payment_id
         FROM sport_center.payment_settlement_items
         WHERE settlement_id=${settlementId}
       )
       AND NOT EXISTS (
         SELECT 1 FROM sport_center.payment_settlement_items i
         JOIN sport_center.payment_settlement_batches b ON b.id=i.settlement_id
         WHERE i.payment_id=p.id AND i.item_status='active'
           AND b.status IN ('draft','calculated','posted','reconciled')
       )
    `);
    await tx.execute(sql`
      UPDATE public.bank_reconciliation_matches
      SET status = 'superseded'
      WHERE id = ${(matchResult.rows[0] as Record<string, unknown>).id}
        AND status IN ('approved', 'candidate')
    `);
    await tx.execute(sql`
      UPDATE public.bank_mutations
      SET status = 'unmatched',
          reconciliation_status = 'unmatched',
          review_code = 'QRIS_MEMBERSHIP_CORRECTION_PENDING',
          review_reason = 'Kandidat historical dibatalkan karena koreksi keanggotaan settlement. Perlu matching ulang dari sumber pembayaran yang sah.',
          approved_by = NULL,
          approved_at = NULL,
          posted_by = NULL,
          posted_at = NULL,
          updated_at = NOW()
      WHERE id = ${correctionBankMutationId}
        AND status IN ('approved', 'matched', 'auto_matched')
        AND journal_entry_id IS NULL
    `);
    await tx.execute(sql`
      INSERT INTO public.bank_reconciliation_audit (mutation_id, action, actor, meta)
      VALUES (
        ${correctionBankMutationId},
        'CANONICAL_SETTLEMENT_MEMBERSHIP_CORRECTION_REVERSED',
        ${actor},
        jsonb_build_object(
          'settlement_id', ${settlementId}::bigint,
          'original_settlement_journal_id', ${journalId}::integer,
          'reversal_settlement_journal_id', ${reversalJournalId}::integer,
          'replacement_payment_ids', ${JSON.stringify(replacementPaymentIds)}::jsonb,
          'reason', ${reason}::text,
          'old_payment_ids', ${JSON.stringify(
            activeItemsResult.rows.map((row) => Number((row as Record<string, unknown>).payment_id)),
          )}::jsonb
        )
      )
    `);

    return {
      ok: true,
      idempotent: false,
      settlementId,
      reversedSettlementJournalId: reversalJournalId,
      replacementPaymentIds,
      bankMutationId: correctionBankMutationId,
      settlementStatus: "reversed",
      bankMutationStatus: "unmatched",
    };
  });
}