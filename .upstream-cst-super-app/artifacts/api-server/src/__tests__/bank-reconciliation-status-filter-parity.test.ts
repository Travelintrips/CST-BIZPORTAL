import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import express from "express";
import pg from "pg";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getIsolatedTestDatabaseUrl } from "../test-setup.js";

const routeSource = readFileSync(
  new URL("../routes/bankReconciliation.ts", import.meta.url),
  "utf8",
);

const listStart = routeSource.indexOf(
  "// ─── GET /api/bank-reconciliation/mutations",
);
const listEnd = routeSource.indexOf(
  "// Historical repair only",
  listStart,
);
const listRoute = routeSource.slice(listStart, listEnd);

const summaryStart = routeSource.indexOf(
  "// ─── GET /api/bank-reconciliation/summary",
);
const summaryEnd = routeSource.indexOf(
  "// ─── GET /api/bank-reconciliation/audit",
  summaryStart,
);
const summaryRoute = routeSource.slice(summaryStart, summaryEnd);

describe("bank reconciliation status source parity", () => {
  it("filters every requested bank mutation status by the effective projection", () => {
    expect(listRoute).toContain(
      'const effectiveStatus = effectiveBankMutationStatusSql("bm");',
    );
    expect(listRoute).toContain(
      "bmFilters.push(`${effectiveStatus} = '${esc(status)}'`);",
    );
    expect(listRoute).not.toContain(
      "bmFilters.push(`bm.status = '${esc(status)}'`);",
    );
  });

  it("filters imported mutations by the same status expression returned in rows", () => {
    expect(listRoute).toContain(
      'const effectiveImportStatus = effectiveBankMutationImportStatusSql("bmi");',
    );
    expect(listRoute).toContain(
      "bmiFilters.push(`${effectiveImportStatus} = '${esc(status)}'`);",
    );
    expect(listRoute).toContain(
      '${effectiveBankMutationImportStatusSql("bmi")} AS status',
    );
  });

  it("keeps imported NEED_REVIEW rows in the duplicate review queue", () => {
    expect(routeSource).toContain(
      "WHEN ${alias}.status = 'NEED_REVIEW'",
    );
    expect(routeSource).toContain(
      "THEN 'duplicate_need_review'",
    );
    expect(listRoute).toContain(
      "bmiFilters.push(`${effectiveImportStatus} = '${esc(status)}'`);",
    );
  });

  it("counts from the same filtered predicates used by the paginated list", () => {
    expect(listRoute).toContain(
      "SELECT bm.id FROM bank_mutations bm ${bmWhere}",
    );
    expect(listRoute).toContain(
      "SELECT bmi.id FROM bank_mutation_imports bmi ${bmiWhere}",
    );
    expect(listRoute).toContain(
      "total: Number((countRows[0] as any)?.total ?? 0)",
    );
  });

  it("includes deduplicated imported review rows in the summary projection", () => {
    expect(summaryRoute).toContain(
      '${effectiveBankMutationImportStatusSql("bmi")} AS status',
    );
    expect(summaryRoute).toContain(
      "FROM bank_mutation_imports bmi",
    );
    expect(summaryRoute).toContain(
      "bm2.mutation_key::text = COALESCE(bmi.unique_key::text, bmi.id::text)",
    );
  });

  it("groups the summary by the effective bank mutation status projection", () => {
    expect(summaryRoute).toContain(
      '${effectiveBankMutationStatusSql("bm")} AS status',
    );
    expect(summaryRoute).toContain("GROUP BY 1");
  });
});

const hasIsolatedDatabase =
  Boolean(process.env.TEST_DATABASE_URL || process.env.STAGING_DATABASE_URL);

describe.skipIf(!hasIsolatedDatabase)(
  "bank reconciliation status endpoint parity",
  () => {
    const marker = `status-parity-${randomUUID()}`;
    const { Pool } = pg;
    let pool: pg.Pool;
    let app: express.Express;
    let companyId: number;

    const expectedBankDescriptions: Record<string, string[]> = {
      manual_review: [`${marker}-manual-a`, `${marker}-manual-b`],
      unmatched: [`${marker}-required-candidate`],
      duplicate_need_review: [`${marker}-stale-match`],
      approved: [`${marker}-approved`],
      rejected: [`${marker}-rejected`],
    };

    const expectedImportDescriptions: Record<string, string[]> = {
      approved: [`${marker}-import-approved`],
      rejected: [`${marker}-import-rejected`],
      unmatched: [`${marker}-import-unmatched`],
    };

    beforeAll(async () => {
      pool = new Pool({
        connectionString: getIsolatedTestDatabaseUrl(),
        ssl: { rejectUnauthorized: false },
        max: 2,
        connectionTimeoutMillis: 15_000,
      });

      const { bankReconciliationRouter, runBankReconciliationCoreMigration } =
        await import("../routes/bankReconciliation.js");
      await runBankReconciliationCoreMigration();

      app = express();
      app.use(express.json());
      app.use((req: any, _res, next) => {
        req.user = {
          id: marker,
          email: `${marker}@test.invalid`,
          role: "admin",
        };
        req.isAuthenticated = () => true;
        req.isInternalSession = true;
        next();
      });
      app.use("/api/bank-reconciliation", bankReconciliationRouter);

      const company = await pool.query(
        `INSERT INTO public.companies (company_name, company_code)
         VALUES ($1, $2)
         RETURNING id`,
        [`Status parity ${marker}`, marker],
      );
      companyId = Number(company.rows[0].id);

      const inserted = await pool.query(
        `INSERT INTO public.bank_mutations
           (transaction_date, description, credit_amount, amount, direction,
            mutation_key, normalized_description, status, company_id)
         VALUES
           (CURRENT_DATE, $1, 101, 101, 'IN', $1, $1, 'manual_review', $7),
           (CURRENT_DATE, $2, 102, 102, 'IN', $2, $2, 'manual_review', $7),
           (CURRENT_DATE, $3, 103, 103, 'IN', $3, $3, 'manual_review', $7),
           (CURRENT_DATE, $4, 104, 104, 'IN', $4, $4, 'matched', $7),
           (CURRENT_DATE, $5, 105, 105, 'IN', $5, $5, 'approved', $7),
           (CURRENT_DATE, $6, 106, 106, 'IN', $6, $6, 'rejected', $7)
         RETURNING id, description`,
        [
          expectedBankDescriptions.manual_review[0],
          expectedBankDescriptions.manual_review[1],
          expectedBankDescriptions.unmatched[0],
          expectedBankDescriptions.duplicate_need_review[0],
          expectedBankDescriptions.approved[0],
          expectedBankDescriptions.rejected[0],
          companyId,
        ],
      );
      const mutationId = (description: string) =>
        Number(inserted.rows.find((row) => row.description === description)?.id);

      await pool.query(
        `INSERT INTO public.bank_reconciliation_audit
           (mutation_id, action, actor, meta)
         VALUES ($1, 'RULE_CANDIDATE_REQUIRED', $2, $3::jsonb)`,
        [
          mutationId(expectedBankDescriptions.unmatched[0]),
          marker,
          JSON.stringify({ candidate_requirement: "required" }),
        ],
      );
      await pool.query(
        `INSERT INTO public.bank_reconciliation_matches
           (mutation_id, candidate_type, candidate_id, match_score, match_reason,
            status)
         VALUES ($1, 'accounting_payment', 2147483647, 80, $2, 'candidate')`,
        [mutationId(expectedBankDescriptions.duplicate_need_review[0]), marker],
      );

      await pool.query(
        `INSERT INTO public.bank_mutation_imports
           (transaction_date, description, credit, unique_key, status)
         VALUES
           (CURRENT_DATE, $1, 201, $1, 'IMPORTED'),
           (CURRENT_DATE, $2, 202, $2, 'REJECTED'),
           (CURRENT_DATE, $3, 203, $3, 'DRAFT')`,
        [
          expectedImportDescriptions.approved[0],
          expectedImportDescriptions.rejected[0],
          expectedImportDescriptions.unmatched[0],
        ],
      );
    }, 120_000);

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM public.bank_mutation_imports WHERE description LIKE $1`,
        [`${marker}%`],
      ).catch(() => {});
      await pool.query(
        `DELETE FROM public.bank_mutations WHERE company_id = $1`,
        [companyId],
      ).catch(() => {});
      await pool.query(
        `DELETE FROM public.companies WHERE id = $1`,
        [companyId],
      ).catch(() => {});
      await pool.end();
    });

    for (const status of [
      "manual_review",
      "unmatched",
      "duplicate_need_review",
      "approved",
      "rejected",
    ]) {
      it(`returns only effective ${status} rows`, async () => {
        const response = await supertest(app)
          .get("/api/bank-reconciliation/mutations")
          .query({ status, company_id: companyId, search: marker, limit: 100 });

        expect(response.status).toBe(200);
        const rows = response.body.mutations as Array<{
          description: string;
          status: string;
          _source_table: string;
        }>;
        const expectedDescriptions = [
          ...(expectedBankDescriptions[status] ?? []),
          ...(expectedImportDescriptions[status] ?? []),
        ].sort();

        expect(rows.map((row) => row.description).sort()).toEqual(expectedDescriptions);
        expect(rows.every((row) => row.status === status)).toBe(true);
        expect(response.body.total).toBe(expectedDescriptions.length);
      }, 120_000);
    }

    it("reports the full filtered total before limit and offset", async () => {
      const response = await supertest(app)
        .get("/api/bank-reconciliation/mutations")
        .query({
          status: "manual_review",
          company_id: companyId,
          search: marker,
          limit: 1,
          offset: 1,
        });

      expect(response.status).toBe(200);
      expect(response.body.mutations).toHaveLength(1);
      expect(response.body.total).toBe(2);
    }, 120_000);

    it("groups the same effective bank-mutation statuses in the summary", async () => {
      const response = await supertest(app)
        .get("/api/bank-reconciliation/summary")
        .query({ company_id: companyId });

      expect(response.status).toBe(200);
      const counts = Object.fromEntries(
        response.body.summary.map((row: { status: string; count: string }) => [
          row.status,
          Number(row.count),
        ]),
      );
      expect(counts).toEqual({
        manual_review: 2,
        unmatched: 1,
        duplicate_need_review: 1,
        approved: 1,
        rejected: 1,
      });
    }, 120_000);

    it("does not leak imported rows into unsupported status filters", async () => {
      const response = await supertest(app)
        .get("/api/bank-reconciliation/mutations")
        .query({
          status: "manual_review",
          company_id: companyId,
          search: marker,
          limit: 100,
        });

      expect(response.status).toBe(200);
      expect(
        response.body.mutations.every(
          (row: { _source_table: string }) => row._source_table === "bank_mutations",
        ),
      ).toBe(true);
      expect(response.body.total).toBe(2);
    }, 120_000);
  },
);
