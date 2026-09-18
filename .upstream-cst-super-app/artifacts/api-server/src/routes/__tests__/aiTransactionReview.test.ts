import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findBySourceMock, analyzeAndCreateReviewCaseMock } = vi.hoisted(() => ({
  findBySourceMock: vi.fn(),
  analyzeAndCreateReviewCaseMock: vi.fn(),
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

vi.mock(
  "../../lib/ai/transaction-intelligence/aiTransactionPersistenceService.js",
  () => ({
    analyzeAndCreateReviewCase: analyzeAndCreateReviewCaseMock,
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

  it("rejects unsupported sources with the typed AI review error", async () => {
    const response = await request(makeApp())
      .get("/api/ai-transaction/review-cases/by-source")
      .query({ source: "UNKNOWN_SOURCE", sourceRecordId: "record-123" });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: "AI_REVIEW_SOURCE_UNSUPPORTED",
        message:
          "Source type 'UNKNOWN_SOURCE' is not supported for AI review cross-linking",
      },
    });
    expect(findBySourceMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai-transaction/review-cases/from-source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findBySourceMock.mockResolvedValue([]);
  });

  it("rejects unsupported sources before reading or creating a review case", async () => {
    const response = await request(makeApp())
      .post("/api/ai-transaction/review-cases/from-source")
      .send({
        source: "UNKNOWN_SOURCE",
        sourceRecordId: "record-123",
        transaction: {
          id: "transaction-123",
          description: "Unsupported source transaction",
        },
      });

    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      ok: false,
      error: {
        code: "AI_REVIEW_SOURCE_UNSUPPORTED",
        message:
          "Source type 'UNKNOWN_SOURCE' is not supported for AI review cross-linking",
      },
    });
    expect(findBySourceMock).not.toHaveBeenCalled();
    expect(analyzeAndCreateReviewCaseMock).not.toHaveBeenCalled();
  });
});
