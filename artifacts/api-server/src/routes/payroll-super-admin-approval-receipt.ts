import { createHash } from "node:crypto";
import type { PayrollPreviewItem } from "./payroll-preview";

export const PAYROLL_SUPER_ADMIN_APPROVAL_MARKER = "[PAYROLL_SUPER_ADMIN_APPROVAL_V1]";

export type PayrollSuperAdminApprovalReceipt = {
  actorId: string;
  actorEmail: string;
  digest: string;
  note: string;
};

/**
 * Parse only the durable marker written by the one-stage Super Admin approval
 * endpoint. Legacy HR/Accounting "reviewed" runs remain neutral without it.
 */
export function readPayrollSuperAdminApprovalReceipt(
  notes: unknown,
  approvedAt: unknown,
  status: unknown,
): PayrollSuperAdminApprovalReceipt | null {
  const runStatus = String(status ?? "").trim().toLowerCase();
  if (!["reviewed", "approved", "paid"].includes(runStatus) || approvedAt == null) return null;

  const lines = String(notes ?? "").split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    const prefix = PAYROLL_SUPER_ADMIN_APPROVAL_MARKER + " ";
    if (!line.startsWith(prefix)) continue;

    try {
      const value = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
      const actorId = String(value.actorId ?? "").trim();
      const actorEmail = String(value.actorEmail ?? "").trim().toLowerCase();
      const digest = String(value.digest ?? "").trim();
      const note = String(value.note ?? "").trim();
      const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(actorEmail);
      if (!actorId || !validEmail || !/^[0-9a-f]{64}$/.test(digest) || note.length < 10 || note.length > 500) {
        return null;
      }
      return { actorId, actorEmail, digest, note };
    } catch {
      return null;
    }
  }
  return null;
}

/** Must remain byte-for-byte compatible with the approval endpoint's digest. */
export function payrollSuperAdminApprovalDigest(
  companyId: number,
  runId: number,
  items: PayrollPreviewItem[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ companyId, runId, items }))
    .digest("hex");
}
