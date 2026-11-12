import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ sql: string; values?: unknown[] }>,
  failAt: "" as string,
  released: 0,
}));
vi.mock("@workspace/db", () => ({
  pool: {
    connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        state.calls.push({ sql, values });
        if (state.failAt && sql === state.failAt) throw new Error("DB_TEST_FAILURE");
        return { rows: [], rowCount: 0 };
      },
      release: () => { state.released++; },
    }),
  },
}));
import { withHrdCompanyScope } from "./hrd-db";

describe("HRD production scoped database transaction", () => {
  afterEach(() => { state.calls.length = 0; state.failAt = ""; state.released = 0; });
  it("sets dedicated role and verified company scope transaction-locally", async () => {
    const result = await withHrdCompanyScope(3, async (client) => {
      await client.query("SELECT id FROM hrd_private.employee_documents WHERE company_id=$1", [3]);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(state.calls.map((x) => x.sql)).toEqual([
      "BEGIN",
      "SET LOCAL ROLE bizportal_hrd_prod",
      "SELECT set_config('app.hrd_company_id', $1, true)",
      "SELECT id FROM hrd_private.employee_documents WHERE company_id=$1",
      "COMMIT",
    ]);
    expect(state.calls[2].values).toEqual(["3"]);
    expect(state.released).toBe(1);
  });
  it("rejects invalid company scope before opening a connection", async () => {
    await expect(withHrdCompanyScope(0, async () => "never")).rejects.toThrow("HRD_COMPANY_SCOPE_INVALID");
    expect(state.calls).toHaveLength(0);
    expect(state.released).toBe(0);
  });
  it("rolls back and releases the pooled connection on failure", async () => {
    state.failAt = "SELECT set_config('app.hrd_company_id', $1, true)";
    await expect(withHrdCompanyScope(1, async () => "never")).rejects.toThrow("DB_TEST_FAILURE");
    expect(state.calls.map((x) => x.sql)).toEqual([
      "BEGIN",
      "SET LOCAL ROLE bizportal_hrd_prod",
      "SELECT set_config('app.hrd_company_id', $1, true)",
      "ROLLBACK",
    ]);
    expect(state.released).toBe(1);
  });
});
