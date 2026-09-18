import { describe, expect, it } from "vitest";
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