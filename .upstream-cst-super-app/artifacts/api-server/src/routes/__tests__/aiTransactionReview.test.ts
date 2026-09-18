import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findBySourceMock } = vi.hoisted(() => ({
  findBySourceMock: vi.fn(),
}));

vi.mock("../../lib/resolveCompany.js", () => ({
  resolveCompanyId: vi.fn(() => 42),
}));

vi.mock("../../lib/requireAdmin.js", () => ({
  requireAdmin: vi.fn().mockResolvedValue(true),
  requireRole: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../lib/ai/transaction-intelligence/aiReviewRepository.js", () => ({
  aiReviewCaseRepo: {
    findBySource: findBySourceMock,
  },
  aiReviewSnapshotRepo: {},
  aiReviewAuditRepo: {},
  aiLearningFeedbackRepo: {},
  aiRuleRecommendationRepo: {},
}));

vi.mock("../../lib/ai/transaction-intelligence/aiReviewErrors.js", () => ({
  sourceUnsupported: vi.fn(
    (source: string) => new Error(`Unsupported source: ${source}`),
  ),
  toSafeErrorResponse: vi.fn(() => ({
    statusCode: 500,
    body: {
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "Internal error" },
    },
  })),
  AIReviewError: class AIReviewError extends Error {},
}));

vi.mock(
  "../../lib/ai/transaction-intelligence/aiTransactionPersistenceService.js",
  () => ({
    analyzeAndCreateReviewCase: vi.fn(),
    recordAIReviewerDecision: vi.fn(),
    reevaluateAIReviewCase: vi.fn(),
    getReviewCaseDetail: vi.fn(),
    getObservabilityData: vi.fn(),
  }),
);

vi.mock("../../lib/logger.js", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { aiTransactionReviewRouter } from "../aiTransactionReview.js";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/ai-transaction", aiTransactionReviewRouter);
  return app;
}

describe("GET /api/ai-transaction/review-cases/by-source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findBySourceMock.mockResolvedValue([]);
  });

  it("reaches the source lookup handler instead of the numeric id route", async () => {
    const response = await request(makeApp())
      .get("/api/ai-transaction/review-cases/by-source")
      .query({ source: "BANK_MUTATION", sourceRecordId: "mutation-123" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      data: { exists: false, reviewCase: null },
    });
    expect(findBySourceMock).toHaveBeenCalledWith(
      42,
      "BANK_MUTATION",
      "mutation-123",
    );
  });

  it("preserves validation when source lookup parameters are missing", async () => {
    const response = await request(makeApp()).get(
      "/api/ai-transaction/review-cases/by-source",
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: "AI_REVIEW_VALIDATION_ERROR",
        message: "source and sourceRecordId query params are required",
      },
    });
    expect(findBySourceMock).not.toHaveBeenCalled();
  });
});
