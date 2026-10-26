import { describe, expect, it } from "vitest";

/**
 * Pure accounting-policy fixtures; these are not DB transaction/E2E tests.
 * Posted original and reversal remain visible in their own periods even after
 * the original is flagged reversed. Financial reports must net both entries.
 */
type Entry = {
  id: number;
  companyId: number;
  month: string;
  posted: boolean;
  reversed: boolean;
  lines: Array<{ account: number; debit: number; credit: number }>;
};

const entries: Entry[] = [
  { id: 1, companyId: 1, month: "2026-07", posted: true, reversed: true,
    lines: [{ account: 101, debit: 100, credit: 0 }, { account: 201, debit: 0, credit: 100 }] },
  { id: 2, companyId: 1, month: "2026-10", posted: true, reversed: false,
    lines: [{ account: 101, debit: 0, credit: 100 }, { account: 201, debit: 100, credit: 0 }] },
  { id: 3, companyId: 2, month: "2026-10", posted: true, reversed: false,
    lines: [{ account: 101, debit: 40, credit: 0 }, { account: 201, debit: 0, credit: 40 }] },
];

function netByAccount(companyId: number, throughMonth: string, fromMonth = "0000-00") {
  const totals = new Map<number, number>();
  for (const entry of entries) {
    if (!entry.posted || entry.companyId !== companyId ||
        entry.month < fromMonth || entry.month > throughMonth) continue;
    for (const line of entry.lines) {
      totals.set(line.account, (totals.get(line.account) ?? 0) + line.debit - line.credit);
    }
  }
  return totals;
}

describe("Vendor Invoice reversal reporting period policy", () => {
  it("retains original historical month and recognizes reversal only in posting month", () => {
    expect(netByAccount(1, "2026-07").get(101)).toBe(100);
    expect(netByAccount(1, "2026-10", "2026-10").get(101)).toBe(-100);
  });

  it("nets original and reversal to zero cumulatively for every account", () => {
    expect([...netByAccount(1, "2026-10").values()]).toEqual([0, 0]);
  });

  it("does not leak a second company's entries into the first company", () => {
    expect(netByAccount(1, "2026-10").get(101)).toBe(0);
    expect(netByAccount(2, "2026-10").get(101)).toBe(40);
  });

  it("demonstrates why excluding reversed originals is incorrect", () => {
    const incorrectlyFiltered = entries
      .filter((entry) => entry.companyId === 1 && entry.posted && !entry.reversed)
      .flatMap((entry) => entry.lines)
      .filter((line) => line.account === 101)
      .reduce((sum, line) => sum + line.debit - line.credit, 0);
    expect(incorrectlyFiltered).toBe(-100);
    expect(netByAccount(1, "2026-10").get(101)).toBe(0);
  });
});
