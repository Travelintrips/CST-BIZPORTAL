import { createRequire } from "node:module";

const pg = createRequire(new URL("../lib/db/package.json", import.meta.url))("pg");

const PAYMENT_ID = 316;
const OLD_JOURNAL_ID = 544;
const REVERSAL_ID = 971;
const MALFORMED_REVERSAL_ID = 972;
const DUPLICATE_REVERSAL_ID = 973;
const BOOKING_ID = 36;
const TEMPLATE_PAYMENT_ID = 63;
const TEMPLATE_JOURNAL_ID = 76;

const pool = new pg.Pool({
  connectionString: process.env.SUPABASE_DATABASE_URL_DEV,
  max: 1,
});
const client = await pool.connect();

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const insertRow = async (table, row, { id } = {}) => {
  const omitted = new Set(["id", "created_at", "updated_at"]);
  const columns = Object.keys(row).filter((column) => !omitted.has(column));
  const values = columns.map((column) => row[column]);
  const idColumn = id == null ? "" : `${quoteIdentifier("id")}, `;
  const idValue = id == null ? "" : `${id}, `;
  const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
  await client.query(
    `INSERT INTO ${table} (${idColumn}${columns.map(quoteIdentifier).join(", ")})
     VALUES (${idValue}${placeholders})`,
    values,
  );
};

const insertJournalLines = async (journalId, lines, reversed = false) => {
  for (const line of lines) {
    await client.query(
      `INSERT INTO sport_center.accounting_journal_lines
         (journal_id, line_type, account_code, account_name, amount, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        journalId,
        reversed
          ? line.line_type === "debit"
            ? "credit"
            : line.line_type === "credit"
              ? "debit"
              : line.line_type
          : line.line_type,
        line.account_code,
        line.account_name,
        line.amount,
        reversed ? `Regression reversal of journal #${OLD_JOURNAL_ID}` : line.description,
      ],
    );
  }
};

const callDraftOwner = async () => {
  const result = await client.query(
    "SELECT sport_center.create_payment_accounting_draft_owner($1, NULL) AS journal_id",
    [PAYMENT_ID],
  );
  return Number(result.rows[0].journal_id);
};

try {
  await client.query("BEGIN");

  const occupied = await client.query(
    `SELECT id FROM sport_center.sport_payments WHERE id = $1
     UNION ALL
     SELECT id FROM sport_center.accounting_journals WHERE id = ANY($2::int[])`,
    [PAYMENT_ID, [OLD_JOURNAL_ID, REVERSAL_ID, MALFORMED_REVERSAL_ID, DUPLICATE_REVERSAL_ID]],
  );
  assert(
    occupied.rowCount === 0,
    "DEV regression fixture IDs are occupied; refusing to overwrite existing data",
  );

  const paymentTemplate = (
    await client.query("SELECT * FROM sport_center.sport_payments WHERE id = $1", [
      TEMPLATE_PAYMENT_ID,
    ])
  ).rows[0];
  const journalTemplate = (
    await client.query("SELECT * FROM sport_center.accounting_journals WHERE id = $1", [
      TEMPLATE_JOURNAL_ID,
    ])
  ).rows[0];
  const sourceLines = (
    await client.query(
      "SELECT line_type, account_code, account_name, amount, description FROM sport_center.accounting_journal_lines WHERE journal_id = $1 ORDER BY id",
      [TEMPLATE_JOURNAL_ID],
    )
  ).rows;
  const publicJournalId = (
    await client.query("SELECT id FROM public.accounting_journals ORDER BY id LIMIT 1")
  ).rows[0]?.id;
  assert(publicJournalId != null, "DEV public journal template is missing");
  assert(paymentTemplate && journalTemplate && sourceLines.length > 0, "DEV templates are missing");

  const payment = {
    ...paymentTemplate,
    id: undefined,
    booking_id: BOOKING_ID,
    amount: "160000.00",
    status: "confirmed",
    confirmed_at: "2026-09-16T00:00:00Z",
    paid_at: "2026-09-16T00:00:00Z",
    net_amount: "160000.00",
    settlement_status: "unsettled",
  };
  await insertRow("sport_center.sport_payments", payment, { id: PAYMENT_ID });

  const oldJournal = {
    ...journalTemplate,
    id: undefined,
    booking_id: BOOKING_ID,
    order_number: "REGRESSION-316",
    journal_type: "payment_confirmed",
    status: "approved",
    payment_id: PAYMENT_ID,
    is_reversal: false,
    reversal_of_id: null,
    company_id: 1,
    debit_amount: "640000.00",
    credit_revenue_amount: "576577.00",
    credit_ppn_amount: "63423.00",
    gross_amount: "640000.00",
    dpp_amount: "576577.00",
    tax_amount: "63423.00",
    source_event_id: null,
    correlation_id: null,
    source_schema: null,
    source_table: null,
    source_id: null,
  };
  await insertRow("sport_center.accounting_journals", oldJournal, { id: OLD_JOURNAL_ID });
  await insertJournalLines(OLD_JOURNAL_ID, sourceLines);
  await client.query(
    "UPDATE sport_center.accounting_journals SET status = 'posted' WHERE id = $1",
    [OLD_JOURNAL_ID],
  );

  const reversalJournal = {
    ...oldJournal,
    id: undefined,
    journal_type: "reversal",
    payment_id: null,
    is_reversal: true,
    reversal_of_id: OLD_JOURNAL_ID,
    status: "draft",
  };
  await insertRow("sport_center.accounting_journals", reversalJournal, { id: REVERSAL_ID });
  await insertJournalLines(REVERSAL_ID, sourceLines, true);
  await client.query(
    "UPDATE sport_center.accounting_journals SET status = 'posted' WHERE id = $1",
    [REVERSAL_ID],
  );

  await client.query(
    `INSERT INTO public.accounting_entries
       (company_id, entry_number, journal_id, date, ref, description, status,
        source, source_id, total_debit, total_credit, entry_status,
        source_payment_id, payment_method, payment_provider, payment_type,
        provider_order_id)
     VALUES
       (1, 'REGRESSION-316', $1, '2026-09-16', 'REGRESSION-316',
        'Historical public projection for regression', 'posted',
         'sport_center_payment', $2, 640000, 640000, 'POSTED',
         $3, 'QRIS', 'mandiri_direct', 'full_payment', 'legacy-order-316')`,
    [publicJournalId, PAYMENT_ID, PAYMENT_ID],
  );

  const firstDraftId = await callDraftOwner();
  assert(firstDraftId !== OLD_JOURNAL_ID, "reversed journal was incorrectly reused");
  const firstDraft = (
    await client.query(
      `SELECT id, payment_id, status, gross_amount, debit_amount
         FROM sport_center.accounting_journals
        WHERE id = $1`,
      [firstDraftId],
    )
  ).rows[0];
  assert(firstDraft?.payment_id === PAYMENT_ID, "new draft has the wrong payment owner");
  assert(firstDraft.status === "draft", "new journal is not a draft");
  assert(Number(firstDraft.gross_amount) === 160000, "new draft amount is not Rp160.000");
  assert(Number(firstDraft.debit_amount) === 160000, "new draft debit is not Rp160.000");

  await client.query("SAVEPOINT malformed_reversal");
  try {
    await client.query(
      `INSERT INTO sport_center.accounting_journals
         (id, booking_id, order_number, journal_type, status, debit_account,
          debit_amount, credit_revenue_account, credit_revenue_amount,
          credit_ppn_account, credit_ppn_amount, journal_date, is_reversal,
          reversal_of_id, payment_id, company_id)
       VALUES
         ($1, $2, 'REGRESSION-316', 'reversal', 'draft', 'Bad',
          640000, 'Bad', 576577, 'Bad', 63423, '2026-09-16', true,
          $3, NULL, 1)`,
      [MALFORMED_REVERSAL_ID, BOOKING_ID, OLD_JOURNAL_ID],
    );
    await callDraftOwner();
    throw new Error("malformed reversal was not rejected");
  } catch (error) {
    assert(
      String(error.message).includes("PAYMENT_CONFIRMATION_REVERSAL_INVALID"),
      `unexpected malformed-reversal error: ${error.message}`,
    );
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT malformed_reversal");
  }

  await client.query("SAVEPOINT duplicate_reversal");
  try {
    await insertRow("sport_center.accounting_journals", reversalJournal, {
      id: DUPLICATE_REVERSAL_ID,
    });
    await insertJournalLines(DUPLICATE_REVERSAL_ID, sourceLines, true);
    await callDraftOwner();
    throw new Error("duplicate reversal was not rejected");
  } catch (error) {
    assert(
      String(error.message).includes("PAYMENT_CONFIRMATION_REVERSAL_INVALID"),
      `unexpected duplicate-reversal error: ${error.message}`,
    );
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT duplicate_reversal");
  }

  const secondDraftId = await callDraftOwner();
  assert(secondDraftId === firstDraftId, "second call did not return the new draft idempotently");

  const historicalState = await client.query(
    `SELECT id, payment_id, status, is_reversal, reversal_of_id, gross_amount
       FROM sport_center.accounting_journals
      WHERE id = ANY($1::int[])
      ORDER BY id`,
    [[OLD_JOURNAL_ID, REVERSAL_ID]],
  );
  assert(historicalState.rowCount === 2, "historical journals were removed or replaced");
  assert(
    Number(historicalState.rows.find((row) => row.id === OLD_JOURNAL_ID).gross_amount) === 640000,
    "old journal amount changed",
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        paymentId: PAYMENT_ID,
        oldJournalId: OLD_JOURNAL_ID,
        reversalId: REVERSAL_ID,
        firstDraftId,
        secondDraftId,
        malformedReversalRejected: true,
        duplicateReversalRejected: true,
        historicalJournalsPreserved: true,
      },
      null,
      2,
    ),
  );
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}