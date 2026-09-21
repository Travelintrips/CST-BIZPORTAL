import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { authenticateAdmin, type AdminRequest } from "./admin-auth";

const router: IRouter = Router();
router.use(authenticateAdmin);

const SUPPORTED_SOURCES = new Set([
  "BANK_MUTATION",
  "BANK_RECONCILIATION",
  "TREASURY",
  "ACCOUNTING_ENTRY",
  "EXPENSE",
  "CASH_ADVANCE",
  "VENDOR_PAYMENT",
  "CUSTOMER_PAYMENT",
  "INVOICE",
  "SALES_DOCUMENT",
  "PURCHASE",
  "LOGISTIC_ORDER",
  "SPORT_PAYMENT",
  "PPJK",
  "EXPECTED_CASH_FLOW",
  "bank_mutation",
  "bank_reconciliation",
  "treasury",
  "accounting_entry",
  "expense",
  "cash_advance",
  "vendor_payment",
  "customer_payment",
  "invoice",
  "sales_document",
  "purchase",
  "logistic_order",
  "sport_payment",
  "ppjk",
  "expected_cash_flow",
]);

function asPositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function asNumberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asStringOrUndefined(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function toIsoOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function resolveCompanyScope(request: Request, response: Response): number | null {
  const requestedCompanyId = asPositiveInt(request.query.companyId);
  const sessionCompanyId = (request as AdminRequest).adminUser?.companyId ?? null;

  if (sessionCompanyId && requestedCompanyId && sessionCompanyId !== requestedCompanyId) {
    response.status(403).json({
      ok: false,
      error: {
        code: "AI_REVIEW_COMPANY_MISMATCH",
        message: "The resource does not belong to your company context",
      },
    });
    return null;
  }

  const companyId = sessionCompanyId ?? requestedCompanyId;
  if (!companyId) {
    response.status(400).json({
      ok: false,
      error: {
        code: "AI_REVIEW_VALIDATION_ERROR",
        message: "companyId is required for this standalone deployment",
      },
    });
    return null;
  }

  return companyId;
}

function mapReviewCase(row: Record<string, unknown>) {
  const dueAt = toIsoOrUndefined(row.due_at);
  const dueMs = dueAt ? new Date(dueAt).getTime() : null;
  const nowMs = Date.now();
  const closedAt = toIsoOrUndefined(row.closed_at);
  const terminal = new Set(["APPROVED", "COA_CHANGED", "REJECTED", "CLOSED", "CANCELLED"]);
  const status = String(row.status ?? "");
  const isCompleted = terminal.has(status);
  const isOverdue = dueMs !== null && !isCompleted && dueMs < nowMs;
  const hoursRemaining = dueMs === null ? undefined : (dueMs - nowMs) / 3_600_000;

  const snapshotVersionRaw = asStringOrUndefined(row.snapshot_version);
  const snapshotVersionNumber = snapshotVersionRaw !== undefined && /^\d+$/.test(snapshotVersionRaw)
    ? Number(snapshotVersionRaw)
    : undefined;

  return {
    id: String(row.id),
    transactionId: String(row.transaction_id ?? ""),
    companyId: String(row.company_id ?? ""),
    status,
    queue: String(row.queue ?? ""),
    priority: String(row.priority ?? ""),
    riskLevel: asStringOrUndefined(row.anomaly_risk),
    anomalyScore: asNumberOrUndefined(row.anomaly_score),
    transactionSource: asStringOrUndefined(row.source),
    detectedIntent: asStringOrUndefined(row.intent),
    intentConfidence: asNumberOrUndefined(row.intent_confidence),
    recommendedCoaId: row.recommended_coa_id == null ? undefined : String(row.recommended_coa_id),
    recommendedCoaCode: asStringOrUndefined(row.recommended_coa_code),
    recommendedCoaName: asStringOrUndefined(row.recommended_coa_name),
    coaConfidence: asNumberOrUndefined(row.recommended_coa_confidence),
    manualReviewFlag: row.requires_manual_review == null ? undefined : Boolean(row.requires_manual_review),
    assignedReviewerId: asStringOrUndefined(row.assigned_reviewer_id),
    assignedReviewerRole: asStringOrUndefined(row.assigned_reviewer_role),
    sla: dueAt
      ? {
          dueAt,
          deadlineAt: dueAt,
          isOverdue,
          hoursRemaining,
          slaStatus: isCompleted
            ? "COMPLETED"
            : isOverdue
              ? "OVERDUE"
              : hoursRemaining !== undefined && hoursRemaining <= 4
                ? "AT_RISK"
                : "ON_TRACK",
        }
      : undefined,
    snapshotVersion: snapshotVersionNumber,
    policyVersion: asStringOrUndefined(row.decision_policy_version),
    createdAt: toIsoOrUndefined(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIsoOrUndefined(row.updated_at),
    decidedAt: closedAt,
  };
}

router.get(
  "/ai-transaction/review-cases/by-source",
  async (request, response): Promise<void> => {
    const companyId = resolveCompanyScope(request, response);
    if (!companyId) return;

    const source = typeof request.query.source === "string" ? request.query.source.trim() : "";
    const sourceRecordId = typeof request.query.sourceRecordId === "string"
      ? request.query.sourceRecordId.trim()
      : "";

    if (!source || !sourceRecordId) {
      response.status(400).json({
        ok: false,
        error: {
          code: "AI_REVIEW_VALIDATION_ERROR",
          message: "source and sourceRecordId query params are required",
        },
      });
      return;
    }

    if (!SUPPORTED_SOURCES.has(source)) {
      response.status(422).json({
        ok: false,
        error: {
          code: "AI_REVIEW_SOURCE_UNSUPPORTED",
          message: `Source type '${source}' is not supported for AI review cross-linking`,
        },
      });
      return;
    }

    try {
      const result = await pool.query(
        `select
           id,
           company_id,
           transaction_id,
           source,
           source_record_id,
           queue::text as queue,
           priority::text as priority,
           status::text as status,
           intent,
           intent_confidence,
           recommended_coa_id,
           recommended_coa_code,
           recommended_coa_name,
           recommended_coa_confidence,
           anomaly_score,
           anomaly_risk,
           requires_manual_review,
           decision_policy_version,
           snapshot_version,
           assigned_reviewer_id,
           assigned_reviewer_role,
           created_at,
           updated_at,
           due_at,
           closed_at
         from public.ai_review_cases
         where company_id = $1
           and source = $2
           and source_record_id = $3
         order by created_at desc
         limit 1`,
        [companyId, source, sourceRecordId],
      );

      const reviewCase = result.rows[0] ? mapReviewCase(result.rows[0]) : null;
      response.json({
        ok: true,
        data: {
          exists: reviewCase !== null,
          reviewCase,
        },
      });
    } catch (error) {
      request.log.error(
        { error, companyId, source, sourceRecordId },
        "Standalone AI review source lookup failed",
      );
      response.status(500).json({
        ok: false,
        error: {
          code: "AI_REVIEW_DATABASE_ERROR",
          message: "A database error occurred. Please try again.",
        },
      });
    }
  },
);

export default router;
