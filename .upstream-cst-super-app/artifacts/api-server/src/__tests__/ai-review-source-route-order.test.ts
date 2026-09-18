import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  new URL("../routes/aiTransactionReview.ts", import.meta.url),
  "utf8",
);

describe("AI Review source lookup route contract", () => {
  it("registers /by-source before the parameterized /:id route", () => {
    const sourceRoute = "aiTransactionReviewRouter.get('/review-cases/by-source'";
    const detailRoute = "aiTransactionReviewRouter.get('/review-cases/:id'";

    const sourceRouteIndex = routeSource.indexOf(sourceRoute);
    const detailRouteIndex = routeSource.indexOf(detailRoute);

    expect(sourceRouteIndex).toBeGreaterThanOrEqual(0);
    expect(detailRouteIndex).toBeGreaterThanOrEqual(0);
    expect(sourceRouteIndex).toBeLessThan(detailRouteIndex);
    expect(routeSource.match(new RegExp(sourceRoute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
  });

  it("keeps source and sourceRecordId validation in the source lookup handler", () => {
    const sourceRouteIndex = routeSource.indexOf(
      "aiTransactionReviewRouter.get('/review-cases/by-source'",
    );
    const detailRouteIndex = routeSource.indexOf(
      "aiTransactionReviewRouter.get('/review-cases/:id'",
    );
    const sourceRoute = routeSource.slice(sourceRouteIndex, detailRouteIndex);

    expect(sourceRoute).toContain("req.query['source']");
    expect(sourceRoute).toContain("req.query['sourceRecordId']");
    expect(sourceRoute).toContain("source and sourceRecordId query params are required");
  });
});