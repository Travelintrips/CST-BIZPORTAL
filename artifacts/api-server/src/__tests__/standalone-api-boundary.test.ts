import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  new URL("../routes/index.ts", import.meta.url),
  "utf8",
);

describe("standalone BizPortal API boundary", () => {
  it("does not proxy unknown API routes to CST-SUPER-APP", () => {
    expect(routeSource).not.toContain("getConfiguredUpstreamOrigin");
    expect(routeSource).not.toContain("buildUpstreamUrl");
    expect(routeSource).not.toContain("requestUpstream");
    expect(routeSource).not.toContain("bizportal_upstream_");
    expect(routeSource).toContain("BIZPORTAL_LOCAL_ENDPOINT_NOT_FOUND");
  });

  it("keeps authentication owned by BizPortal", () => {
    expect(routeSource).toContain("router.use(createDevAuthRouter());");
    expect(routeSource).toContain("router.use(localProductionAuthRouter);");
    expect(routeSource).not.toContain("establishDevelopmentUpstreamSession");
    expect(routeSource).not.toContain("establishProductionUpstreamSession");
  });
});
