import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAmount } from "./bank-sheet-sync";

describe("bank sheet amount parsing", () => {
  it("treats Indonesian dot-separated thousands as whole rupiah", () => {
    expect(parseAmount("685.170")).toBe(685170);
    expect(parseAmount("1.234.567")).toBe(1234567);
  });

  it("preserves decimal values and mixed locale formatting", () => {
    expect(parseAmount("685,17")).toBe(685.17);
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("1,234.56")).toBe(1234.56);
  });

  it("handles currency labels and blank values", () => {
    expect(parseAmount("Rp 1.234.567")).toBe(1234567);
    expect(parseAmount("")).toBe(0);
  });
});

const mocks = vi.hoisted(() => {
  const poolQuery = vi.fn();
  const clientQuery = vi.fn();
  const clientRelease = vi.fn();
  const poolConnect = vi.fn(async () => ({
    query: clientQuery,
    release: clientRelease,
  }));

  return {
    poolQuery,
    clientQuery,
    clientRelease,
    poolConnect,
    readSpreadsheetValues: vi.fn(),
    writeSpreadsheetValues: vi.fn(),
  };
});

vi.mock("@workspace/db", () => ({
  pool: {
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  },
}));

vi.mock("./google-sheets", () => ({
  readSpreadsheetValues: mocks.readSpreadsheetValues,
  spreadsheetCellRange: (tabName: string, columnNumber: number, rowNumber: number) => {
    let column = columnNumber + 1;
    let letters = "";
    while (column > 0) {
      const remainder = (column - 1) % 26;
      letters = String.fromCharCode(65 + remainder) + letters;
      column = Math.floor((column - 1) / 26);
    }
    return `'${tabName}'!${letters}${rowNumber}`;
  },
  writeSpreadsheetValues: mocks.writeSpreadsheetValues,
}));

import { syncOneBankSheetConfig } from "./bank-sheet-sync";

type StoredMutation = {
  id: number;
  mutation_key: string | null;
  canonical_key: string | null;
  status: string | null;
  reconciliation_status: string | null;
  journal_entry_id: number | null;
  company_id: number | null;
  match_score?: number | null;
  match_reason?: string | null;
  match_status?: string | null;
  match_result?: string | null;
  coa_code?: string | null;
  coa_name?: string | null;
};

const config = {
  id: 7,
  company_id: 42,
  sheet_id: "spreadsheet-1",
  tab_name: "Mutasi Bank",
  label: "Rekening utama",
  bank_account_number: null,
};

let storedMutations: StoredMutation[];
let nextMutationId: number;

beforeEach(() => {
  storedMutations = [];
  nextMutationId = 100;
  mocks.poolQuery.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.poolConnect.mockClear();
  mocks.readSpreadsheetValues.mockReset();
  mocks.writeSpreadsheetValues.mockReset();

  mocks.poolQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("from public.bank_sheet_configs")) return { rows: [config] };
    if (sql.includes("update public.bank_sheet_configs")) return { rows: [] };
    throw new Error(`Unexpected pool query: ${sql}`);
  });

  mocks.clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/^(begin|commit|rollback)$/i.test(sql.trim())) return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };

    if (sql.includes("from public.bank_mutations bm")) {
      const mutationKeys = (params?.[1] as string[]) ?? [];
      const canonicalKeys = (params?.[2] as string[]) ?? [];
      return {
        rows: storedMutations.filter((mutation) =>
          (mutation.mutation_key != null && mutationKeys.includes(mutation.mutation_key)) ||
          (mutation.canonical_key != null && canonicalKeys.includes(mutation.canonical_key)),
        ),
      };
    }

    if (sql.includes("insert into public.bank_mutations")) {
      const [mutationKey, canonicalKey, transactionDate, description, amount, direction] = params ?? [];
      const alreadyStored = storedMutations.some(
        (mutation) =>
          mutation.mutation_key === mutationKey || mutation.canonical_key === canonicalKey,
      );
      if (alreadyStored) return { rows: [] };

      const mutation: StoredMutation = {
        id: nextMutationId++,
        mutation_key: String(mutationKey),
        canonical_key: String(canonicalKey),
        status: "unmatched",
        reconciliation_status: null,
        journal_entry_id: null,
        company_id: 42,
      };
      storedMutations.push(mutation);
      expect(transactionDate).toEqual(expect.any(String));
      expect(description).toEqual(expect.any(String));
      expect(Number(amount)).toBeGreaterThan(0);
      expect(["IN", "OUT"]).toContain(direction);
      return { rows: [mutation] };
    }

    throw new Error(`Unexpected client query: ${sql}`);
  });

  mocks.writeSpreadsheetValues.mockResolvedValue(undefined);
});

describe("Google Sheet bank mutation sync", () => {
  it("reads sheet mutation_key values, falls back to a canonical key, and is idempotent", async () => {
    storedMutations.push({
      id: 1,
      mutation_key: "sheet-key-existing",
      canonical_key: "legacy-canonical-key",
      status: "matched",
      reconciliation_status: null,
      journal_entry_id: null,
      company_id: 42,
    });
    mocks.readSpreadsheetValues.mockResolvedValue([
      ["Tanggal", "Keterangan", "Debit", "Kredit", "mutation_key", "status"],
      ["2026-09-01", "Pembayaran existing", "0", "100000", "sheet-key-existing", ""],
      ["2026-09-02", "Pembayaran baru", "0", "250000", "", ""],
    ]);

    const first = await syncOneBankSheetConfig(config.id);
    const firstExistingLookup = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("from public.bank_mutations bm"),
    )?.[1] as unknown[];
    const firstCanonicalKeys = [...((firstExistingLookup?.[2] as string[]) ?? [])];

    const second = await syncOneBankSheetConfig(config.id);
    const existingLookups = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("from public.bank_mutations bm"),
    );
    const insertCalls = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("insert into public.bank_mutations"),
    );

    expect(first).toMatchObject({ imported: 1, existing: 1, total: 2 });
    expect(second).toMatchObject({ imported: 0, existing: 2, total: 2 });
    expect(insertCalls).toHaveLength(1);
    expect(String(insertCalls[0]?.[1]?.[0])).toMatch(/^[a-f0-9]{64}$/);
    expect(existingLookups).toHaveLength(2);
    expect(existingLookups[1]?.[1]?.[2]).toEqual(firstCanonicalKeys);

    const firstWrite = mocks.writeSpreadsheetValues.mock.calls[0]?.[1] as Array<{
      range: string;
      values: string[][];
    }>;
    expect(firstWrite).toEqual(expect.arrayContaining([
      { range: "'Mutasi Bank'!E2", values: [["sheet-key-existing"]] },
      { range: "'Mutasi Bank'!F2", values: [["MATCHED"]] },
      { range: "'Mutasi Bank'!E3", values: [[expect.stringMatching(/^[a-f0-9]{64}$/)]] },
      { range: "'Mutasi Bank'!F3", values: [["UNMATCHED"]] },
    ]));
  });

  it("creates mutation_key and status columns before writing row metadata", async () => {
    mocks.readSpreadsheetValues.mockResolvedValue([
      ["Tanggal", "Keterangan", "Debit", "Kredit"],
      ["2026-09-03", "Setoran tunai", "0", "500000"],
    ]);

    await syncOneBankSheetConfig(config.id);

    const updates = mocks.writeSpreadsheetValues.mock.calls[0]?.[1];
    expect(updates).toEqual([
      { range: "'Mutasi Bank'!E1", values: [["mutation_key"]] },
      { range: "'Mutasi Bank'!F1", values: [["status_recon"]] },
      { range: "'Mutasi Bank'!G1", values: [["coa"]] },
      { range: "'Mutasi Bank'!H1", values: [["nama_coa"]] },
      { range: "'Mutasi Bank'!I1", values: [["match_score"]] },
      { range: "'Mutasi Bank'!J1", values: [["match_result"]] },
      { range: "'Mutasi Bank'!K1", values: [["last_sync"]] },
      { range: "'Mutasi Bank'!E2", values: [[expect.stringMatching(/^[a-f0-9]{64}$/)]] },
      { range: "'Mutasi Bank'!F2", values: [["UNMATCHED"]] },
      { range: "'Mutasi Bank'!G2", values: [[""]] },
      { range: "'Mutasi Bank'!H2", values: [[""]] },
      { range: "'Mutasi Bank'!I2", values: [[""]] },
      { range: "'Mutasi Bank'!J2", values: [[""]] },
      { range: "'Mutasi Bank'!K2", values: [[expect.any(String)]] },
    ]);
  });

  it("writes the reconciled status and match metadata back to existing sheet columns", async () => {
    storedMutations.push({
      id: 9,
      mutation_key: "reconciled-key",
      canonical_key: "reconciled-canonical",
      status: "posted",
      reconciliation_status: "reconciled",
      journal_entry_id: 11,
      company_id: 42,
      match_score: 98,
      match_reason: "Nominal dan vendor cocok",
      match_status: "approved",
      match_result: "Nominal dan vendor cocok",
      coa_code: "51001",
      coa_name: "Beban Operasional",
    });
    mocks.readSpreadsheetValues.mockResolvedValue([
      ["Tanggal", "Keterangan", "Debit", "Kredit", "mutation_key", "status_recon", "coa", "nama_coa", "match_score", "match_result", "last_sync"],
      ["2026-09-05", "Pembayaran vendor", "250000", "0", "reconciled-key", "", "", "", "", "", ""],
    ]);

    await syncOneBankSheetConfig(config.id);

    const updates = mocks.writeSpreadsheetValues.mock.calls[0]?.[1] as Array<{
      range: string;
      values: string[][];
    }>;
    expect(updates).toEqual(expect.arrayContaining([
      { range: "'Mutasi Bank'!E2", values: [["reconciled-key"]] },
      { range: "'Mutasi Bank'!F2", values: [["RECONCILED"]] },
      { range: "'Mutasi Bank'!G2", values: [["51001"]] },
      { range: "'Mutasi Bank'!H2", values: [["Beban Operasional"]] },
      { range: "'Mutasi Bank'!I2", values: [["98"]] },
      { range: "'Mutasi Bank'!J2", values: [["Nominal dan vendor cocok"]] },
      { range: "'Mutasi Bank'!K2", values: [[expect.any(String)]] },
    ]));
  });

  it("deduplicates repeated keyed and canonical rows within one sheet read", async () => {
    mocks.readSpreadsheetValues.mockResolvedValue([
      ["Tanggal", "Keterangan", "Debit", "Kredit", "mutation_key", "status"],
      ["2026-09-04", "Transfer masuk", "0", "125000", "sheet-key-duplicate", ""],
      ["2026-09-04", "Transfer masuk", "0", "125000", "sheet-key-duplicate", ""],
      ["2026-09-05", "Setoran tunai", "0", "275000", "", ""],
      ["2026-09-05", "Setoran tunai", "0", "275000", "", ""],
    ]);

    const result = await syncOneBankSheetConfig(config.id);

    const insertCalls = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("insert into public.bank_mutations"),
    );
    const updates = mocks.writeSpreadsheetValues.mock.calls[0]?.[1] as Array<{
      range: string;
      values: string[][];
    }>;
    const generatedCanonicalKey = updates.find(
      (update) => update.range === "'Mutasi Bank'!E4",
    )?.values[0]?.[0];

    expect(result).toMatchObject({
      imported: 2,
      existing: 2,
      total: 4,
    });
    expect(insertCalls).toHaveLength(2);
    expect(storedMutations).toHaveLength(2);
    expect(generatedCanonicalKey).toMatch(/^[a-f0-9]{64}$/);
    expect(updates).toEqual(expect.arrayContaining([
      { range: "'Mutasi Bank'!E2", values: [["sheet-key-duplicate"]] },
      { range: "'Mutasi Bank'!F2", values: [["UNMATCHED"]] },
      { range: "'Mutasi Bank'!E3", values: [["sheet-key-duplicate"]] },
      { range: "'Mutasi Bank'!F3", values: [["UNMATCHED"]] },
      { range: "'Mutasi Bank'!E4", values: [[generatedCanonicalKey]] },
      { range: "'Mutasi Bank'!F4", values: [["UNMATCHED"]] },
      { range: "'Mutasi Bank'!E5", values: [[generatedCanonicalKey]] },
      { range: "'Mutasi Bank'!F5", values: [["UNMATCHED"]] },
    ]));
  });
}); /* import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseAmount } from "./bank-sheet-sync";

describe("bank sheet amount parsing", () => {
  it("treats Indonesian dot-separated thousands as whole rupiah", () => {
    expect(parseAmount("685.170")).toBe(685170);
    expect(parseAmount("1.234.567")).toBe(1234567);
  });

  it("preserves decimal values and mixed locale formatting", () => {
    expect(parseAmount("685,17")).toBe(685.17);
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("1,234.56")).toBe(1234.56);
  });

  it("handles currency labels and blank values", () => {
    expect(parseAmount("Rp 1.234.567")).toBe(1234567);
    expect(parseAmount("")).toBe(0);
  });
});

const mocks = vi.hoisted(() => {
  const poolQuery = vi.fn();
  const clientQuery = vi.fn();
  const clientRelease = vi.fn();
  const poolConnect = vi.fn(async () => ({
    query: clientQuery,
    release: clientRelease,
  }));

  return {
    poolQuery,
    clientQuery,
    clientRelease,
    poolConnect,
    readSpreadsheetValues: vi.fn(),
    writeSpreadsheetValues: vi.fn(),
  };
});


vi.mock("@workspace/db", () => ({
  pool: {
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  },
}));

vi.mock("./google-sheets", () => ({
  readSpreadsheetValues: mocks.readSpreadsheetValues,
  spreadsheetCellRange: (tabName: string, columnNumber: number, rowNumber: number) => {
    let column = columnNumber + 1;
    let letters = "";
    while (column > 0) {
      const remainder = (column - 1) % 26;
      letters = String.fromCharCode(65 + remainder) + letters;
      column = Math.floor((column - 1) / 26);
    }
    return `'${tabName}'!${letters}${rowNumber}`;
  },
  writeSpreadsheetValues: mocks.writeSpreadsheetValues,
}));

import { syncOneBankSheetConfig } from "./bank-sheet-sync";

type StoredMutation = {
  id: number;
  mutation_key: string | null;
  canonical_key: string | null;
  status: string | null;
  reconciliation_status: string | null;
  journal_entry_id: number | null;
  company_id: number | null;
  match_score?: number | null;
  match_reason?: string | null;
  match_status?: string | null;
  match_result?: string | null;
  coa_code?: string | null;
  coa_name?: string | null;
};

const config = {
  id: 7,
  company_id: 42,
  sheet_id: "spreadsheet-1",
  tab_name: "Mutasi Bank",
  label: "Rekening utama",
  bank_account_number: null,
};

let storedMutations: StoredMutation[];
let nextMutationId: number;

beforeEach(() => {
  storedMutations = [];
  nextMutationId = 100;
  mocks.poolQuery.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();
  mocks.poolConnect.mockClear();
  mocks.readSpreadsheetValues.mockReset();
  mocks.writeSpreadsheetValues.mockReset();

  mocks.poolQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("from public.bank_sheet_configs")) return { rows: [config] };
    if (sql.includes("update public.bank_sheet_configs")) return { rows: [] };
    throw new Error(`Unexpected pool query: ${sql}`);
  });

  mocks.clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/^(begin|commit|rollback)$/i.test(sql.trim())) return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };

    if (sql.includes("from public.bank_mutations bm")) {
      const mutationKeys = (params?.[1] as string[]) ?? [];
      const canonicalKeys = (params?.[2] as string[]) ?? [];
      return {
        rows: storedMutations.filter((mutation) =>
          (mutation.mutation_key != null && mutationKeys.includes(mutation.mutation_key)) ||
          (mutation.canonical_key != null && canonicalKeys.includes(mutation.canonical_key)),
        ),
      };
    }

    if (sql.includes("insert into public.bank_mutations")) {
      const [mutationKey, canonicalKey, transactionDate, description, amount, direction] = params ?? [];
      const alreadyStored = storedMutations.some(
        (mutation) =>
          mutation.mutation_key === mutationKey || mutation.canonical_key === canonicalKey,
      );
      if (alreadyStored) return { rows: [] };

      const mutation: StoredMutation = {
        id: nextMutationId++,
        mutation_key: String(mutationKey),
        canonical_key: String(canonicalKey),
        status: "unmatched",
        reconciliation_status: null,
        journal_entry_id: null,
        company_id: 42,
      };
      storedMutations.push(mutation);
      expect(transactionDate).toEqual(expect.any(String));
      expect(description).toEqual(expect.any(String));
      expect(Number(amount)).toBeGreaterThan(0);
      expect(["IN", "OUT"]).toContain(direction);
      return { rows: [mutation] };
    }

    throw new Error(`Unexpected client query: ${sql}`);
  });

  mocks.writeSpreadsheetValues.mockResolvedValue(undefined);
});

describe("Google Sheet bank mutation sync", () => {
  it("reads sheet mutation_key values, falls back to a canonical key, and is idempotent", async () => {
    storedMutations.push({
      id: 1,
      mutation_key: "sheet-key-existing",
      canonical_key: "legacy-canonical-key",
      status: "matched",
      reconciliation_status: null,
      journal_entry_id: null,
      company_id: 42,
    });
    mocks.readSpreadsheetValues.mockResolvedValue([
      ["Tanggal", "Keterangan", "Debit", "Kredit", "mutation_key", "status"],
      ["2026-09-01", "Pembayaran existing", "0", "100000", "sheet-key-existing", ""],
      ["2026-09-02", "Pembayaran baru", "0", "250000", "", ""],
    ]);

    const first = await syncOneBankSheetConfig(config.id);
    const firstExistingLookup = mocks.clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes("from public.bank_mutations bm"),
    )?.[1] as unknown[];
    const firstCanonicalKeys = [...((firstExistingLookup?.[2] as string[]) ?? [])];

    const second = await syncOneBankSheetConfig(config.id);
    const existingLookups = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("from public.bank_mutations bm"),
    );
    const insertCalls = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("insert into public.bank_mutations"),
    );

    expect(first).toMatchObject({ imported: 1, existing: 1, total: 2 });
    expect(second).toMatchObject({ imported: 0, existing: 2, total: 2 });
    expect(insertCalls).toHaveLength(1);
    expect(String(insertCalls[0]?.[1]?.[0])).toMatch(/^[a-f0-9]{64}$/);
    expect(existingLookups).toHaveLength(2);
    expect(existingLookups[1]?.[1]?.[2]).toEqual(firstCanonicalKeys);

    const firstWrite = mocks.writeSpreadsheetValues.mock.calls[0]?.[1] as Array<{
      range: string;
      values: string[][];
    }>;
    expect(firstWrite).toEqual(expect.arrayContaining([
      { range: "'Mutasi Bank'!E2", values: [["sheet-key-existing"]] },
      { range: "'Mutasi Bank'!F2", values: [["MATCHED"]] },
      { range: "'Mutasi Bank'!E3", values: [[expect.stringMatching(/^[a-f0-9]{64}$/)]] },
      { range: "'Mutasi Bank'!F3", values: [["UNMATCHED"]] },
    ]));
  });

  it("creates mutation_key and status columns before writing row metadata", async () => {
    mocks.readSpreadsheetValues.mockResolvedValue([
      ["Tanggal", "Keterangan", "Debit", "Kredit"],
      ["2026-09-03", "Setoran tunai", "0", "500000"],
    ]);

    await syncOneBankSheetConfig(config.id);

    const updates = mocks.writeSpreadsheetValues.mock.calls[0]?.[1];
    expect(updates).toEqual([
      { range: "'Mutasi Bank'!E1", values: [["mutation_key"]] },
      { range: "'Mutasi Bank'!F1", values: [["status_recon"]] },
      { range: "'Mutasi Bank'!G1", values: [["coa"]] },
      { range: "'Mutasi Bank'!H1", values: [["nama_coa"]] },
      { range: "'Mutasi Bank'!I1", values: [["match_score"]] },
      { range: "'Mutasi Bank'!J1", values: [["match_result"]] },
      { range: "'Mutasi Bank'!K1", values: [["last_sync"]] },
      { range: "'Mutasi Bank'!E2", values: [[expect.stringMatching(/^[a-f0-9]{64}$/)]] },
      { range: "'Mutasi Bank'!F2", values: [["UNMATCHED"]] },
      { range: "'Mutasi Bank'!G2", values: [[""]] },
      { range: "'Mutasi Bank'!H2", values: [[""]] },
      { range: "'Mutasi Bank'!I2", values: [[""]] },
      { range: "'Mutasi Bank'!J2", values: [[""]] },
      { range: "'Mutasi Bank'!K2", values: [[expect.any(String)]] },
    ]);
  });

  it("writes the reconciled status and match metadata back to existing sheet columns", async () => {
    storedMutations.push({
      id: 9,
      mutation_key: "reconciled-key",
      canonical_key: "reconciled-canonical",
      status: "posted",
      reconciliation_status: "reconciled",
      journal_entry_id: 11,
      company_id: 42,
      match_score: 98,
      match_reason: "Nominal dan vendor cocok",
      match_status: "approved",
      match_result: "Nominal dan vendor cocok",
      coa_code: "51001",
      coa_name: "Beban Operasional",
    });
    mocks.readSpreadsheetValues.mockResolvedValue([
      ["Tanggal", "Keterangan", "Debit", "Kredit", "mutation_key", "status_recon", "coa", "nama_coa", "match_score", "match_result", "last_sync"],
      ["2026-09-05", "Pembayaran vendor", "250000", "0", "reconciled-key", "", "", "", "", "", ""],
    ]);

    await syncOneBankSheetConfig(config.id);
    const updates = mocks.writeSpreadsheetValues.mock.calls[0]?.[1] as Array<{
      range: string;
      values: string[][];
    }>;
    expect(updates).toEqual(expect.arrayContaining([
      { range: "'Mutasi Bank'!E2", values: [["reconciled-key"]] },
      { range: "'Mutasi Bank'!F2", values: [["RECONCILED"]] },
      { range: "'Mutasi Bank'!G2", values: [["51001"]] },
      { range: "'Mutasi Bank'!H2", values: [["Beban Operasional"]] },
      { range: "'Mutasi Bank'!I2", values: [["98"]] },
      { range: "'Mutasi Bank'!J2", values: [["Nominal dan vendor cocok"]] },
      { range: "'Mutasi Bank'!K2", values: [[expect.any(String)]] },
    ]));
  });


  it("deduplicates repeated keyed and canonical rows within one sheet read", async () => {
    mocks.readSpreadsheetValues.mockResolvedValue([
      ["Tanggal", "Keterangan", "Debit", "Kredit", "mutation_key", "status"],
      ["2026-09-04", "Transfer masuk", "0", "125000", "sheet-key-duplicate", ""],
      ["2026-09-04", "Transfer masuk", "0", "125000", "sheet-key-duplicate", ""],
      ["2026-09-05", "Setoran tunai", "0", "275000", "", ""],
      ["2026-09-05", "Setoran tunai", "0", "275000", "", ""],
    ]);

    const result = await syncOneBankSheetConfig(config.id);

    const insertCalls = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("insert into public.bank_mutations"),
    );
    const updates = mocks.writeSpreadsheetValues.mock.calls[0]?.[1] as Array<{
      range: string;
      values: string[][];
    }>;
    const generatedCanonicalKey = updates.find(
      (update) => update.range === "'Mutasi Bank'!E4",
    )?.values[0]?.[0];

    expect(result).toMatchObject({
      imported: 2,
      existing: 2,
      total: 4,
    });
    expect(insertCalls).toHaveLength(2);
    expect(storedMutations).toHaveLength(2);
    expect(generatedCanonicalKey).toMatch(/^[a-f0-9]{64}$/);
    expect(updates).toEqual(expect.arrayContaining([
      { range: "'Mutasi Bank'!E2", values: [["sheet-key-duplicate"]] },
      { range: "'Mutasi Bank'!F2", values: [["UNMATCHED"]] },
      { range: "'Mutasi Bank'!E3", values: [["sheet-key-duplicate"]] },
      { range: "'Mutasi Bank'!F3", values: [["UNMATCHED"]] },
      { range: "'Mutasi Bank'!E4", values: [[generatedCanonicalKey]] },
      { range: "'Mutasi Bank'!F4", values: [["UNMATCHED"]] },
      { range: "'Mutasi Bank'!E5", values: [[generatedCanonicalKey]] },
      { range: "'Mutasi Bank'!F5", values: [["UNMATCHED"]] },
    ]));
  });

  it("deduplicates equivalent descriptions and amount formats with one canonical mutation", async () => {
    mocks.readSpreadsheetValues.mockResolvedValue([
      ["Tanggal", "Keterangan", "Debit", "Kredit", "mutation_key", "status"],
      ["2026-09-06", "  transfer   masuk ", "0", "1.250.000,00", "", ""],
      ["2026-09-06", "TRANSFER MASUK", "0", "1250000", "", ""],
    ]);

    const result = await syncOneBankSheetConfig(config.id);

    const insertCalls = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes("insert into public.bank_mutations"),
    );
    const updates = mocks.writeSpreadsheetValues.mock.calls[0]?.[1] as Array<{
      range: string;
      values: string[][];
    }>;
    const rowOneKey = updates.find(
      (update) => update.range === "'Mutasi Bank'!E2",
    )?.values[0]?.[0];
    const rowTwoKey = updates.find(
      (update) => update.range === "'Mutasi Bank'!E3",
    )?.values[0]?.[0];
    const rowOneStatus = updates.find(
      (update) => update.range === "'Mutasi Bank'!F2",
    )?.values[0]?.[0];
    const rowTwoStatus = updates.find(
      (update) => update.range === "'Mutasi Bank'!F3",
    )?.values[0]?.[0];

    expect(result).toMatchObject({
      imported: 1,
      existing: 1,
      total: 2,
    });
    expect(insertCalls).toHaveLength(1);
    expect(storedMutations).toHaveLength(1);
    expect(rowOneKey).toMatch(/^[a-f0-9]{64}$/);
    expect(rowTwoKey).toBe(rowOneKey);
    expect(rowOneStatus).toBe("UNMATCHED");
    expect(rowTwoStatus).toBe(rowOneStatus);
  });
});
*/