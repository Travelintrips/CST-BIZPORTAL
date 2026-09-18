import { afterEach, describe, expect, it } from "vitest";
import {
  buildUpstreamHeaders,
  rewriteSetCookies,
  validateUpstreamBaseUrl,
  validateUpstreamOrigin,
} from "./proxy-policy";

const upstream = new URL("https://cstlogistic.co.id");
const stagingUpstream = new URL("https://staging.cstlogistic.co.id");

const originalEnvironment = {
  APP_ENV: process.env.APP_ENV,
  NODE_ENV: process.env.NODE_ENV,
  SESSION_SECRET: process.env.SESSION_SECRET,
  DEV_IDENTITY_SECRET: process.env.DEV_IDENTITY_SECRET,
  BIZPORTAL_DEV_FORWARD_IDENTITY: process.env.BIZPORTAL_DEV_FORWARD_IDENTITY,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

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

  it("forwards a signed dev identity to staging from development", () => {
    process.env.APP_ENV = "development";
    delete process.env.NODE_ENV;
    process.env.SESSION_SECRET = "development-session-secret-with-32-bytes!!";
    delete process.env.BIZPORTAL_DEV_FORWARD_IDENTITY;

    const headers = buildUpstreamHeaders(
      {},
      stagingUpstream,
      {
        id: "dev:user",
        email: "admin@example.com",
        firstName: "Admin",
        lastName: null,
        role: "admin",
        companyId: null,
      },
    );

    expect(headers["x-bizportal-dev-user"]).toBe("admin@example.com");
    expect(headers["x-bizportal-dev-role"]).toBe("admin");
    expect(headers["x-bizportal-dev-signature"]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("does not forward dev identity when the source is production", () => {
    process.env.APP_ENV = "production";
    process.env.NODE_ENV = "production";
    process.env.SESSION_SECRET = "production-session-secret-with-32-bytes!!";

    const headers = buildUpstreamHeaders(
      {
        "x-bizportal-dev-user": "attacker@example.com",
        "x-bizportal-dev-role": "admin",
        "x-bizportal-dev-signature": "forged",
      },
      stagingUpstream,
      {
        id: "dev:user",
        email: "admin@example.com",
        firstName: "Admin",
        lastName: null,
        role: "admin",
        companyId: null,
      },
    );

    expect(headers["x-bizportal-dev-user"]).toBeUndefined();
    expect(headers["x-bizportal-dev-role"]).toBeUndefined();
    expect(headers["x-bizportal-dev-signature"]).toBeUndefined();
  });

  it("does not forward dev identity to the production upstream", () => {
    process.env.APP_ENV = "development";
    delete process.env.NODE_ENV;
    process.env.SESSION_SECRET = "development-session-secret-with-32-bytes!!";

    const headers = buildUpstreamHeaders(
      {},
      upstream,
      {
        id: "dev:user",
        email: "admin@example.com",
        firstName: "Admin",
        lastName: null,
        role: "admin",
        companyId: null,
      },
    );

    expect(headers["x-bizportal-dev-user"]).toBeUndefined();
    expect(headers["x-bizportal-dev-role"]).toBeUndefined();
    expect(headers["x-bizportal-dev-signature"]).toBeUndefined();
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

  it("allows localhost HTTP only for development upstream services", () => {
    process.env.APP_ENV = "development";
    expect(validateUpstreamBaseUrl("http://127.0.0.1:18444").origin).toBe(
      "http://127.0.0.1:18444",
    );
    expect(() => validateUpstreamBaseUrl("http://example.com")).toThrow();
  });
});