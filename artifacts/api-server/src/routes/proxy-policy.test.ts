import { describe, expect, it } from "vitest";
import {
  buildUpstreamHeaders,
  rewriteSetCookies,
  validateUpstreamOrigin,
} from "./proxy-policy";

const upstream = new URL("https://cstlogistic.co.id");

describe("BizPortal proxy credential boundary", () => {
  it("forwards only namespaced upstream cookies and drops host credentials", () => {
    const headers = buildUpstreamHeaders(
      {
        authorization: "Bearer replit-host-token",
        cookie: "session=private; bizportal_upstream_connect.sid=upstream-value",
        "content-type": "application/json",
      },
      upstream,
    );

    expect(headers.authorization).toBeUndefined();
    expect(headers.cookie).toBe("connect.sid=upstream-value");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.origin).toBe(upstream.origin);
  });

  it("namespaces response cookies and removes their external domain", () => {
    expect(
      rewriteSetCookies([
        "connect.sid=value; Path=/; Domain=cstlogistic.co.id; HttpOnly; Secure",
      ]),
    ).toEqual([
      "bizportal_upstream_connect.sid=value; Path=/; HttpOnly; Secure",
    ]);
  });

  it("accepts only a plain HTTPS origin", () => {
    expect(validateUpstreamOrigin("https://cstlogistic.co.id").origin).toBe(
      "https://cstlogistic.co.id",
    );
    expect(() => validateUpstreamOrigin("http://example.com")).toThrow();
    expect(() => validateUpstreamOrigin("https://user:pass@example.com")).toThrow();
    expect(() => validateUpstreamOrigin("https://example.com/api")).toThrow();
  });
});