/** Posted reversals offset earlier entries; neither entry should be deleted. */
export interface ReversalAwareLedgerRow {
  status: string;
  source?: string | null;
  source_module?: string | null;
  reversal_entry_number?: string | null;
}
export function ledgerReversalState(row: ReversalAwareLedgerRow): "reversal" | "reversed" | "normal" {
  if (row.source === "reversal" || row.source_module === "reversal") return "reversal";
  if (row.reversal_entry_number) return "reversed";
  return "normal";
}
export function canReverseFromLedger(row: ReversalAwareLedgerRow): boolean {
  return row.status === "posted" && ledgerReversalState(row) === "normal";
}
