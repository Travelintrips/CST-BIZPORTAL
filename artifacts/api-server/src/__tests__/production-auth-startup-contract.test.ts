import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexSource = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
const authSource = readFileSync(resolve(process.cwd(), "src/routes/dev-auth.ts"), "utf8");
const localAuthSource = readFileSync(resolve(process.cwd(), "src/routes/local-production-auth.ts"), "utf8");

describe("production auth startup contract", () => {
  it("keeps process liveness independent from production session initialization", () => {
    const listen = indexSource.indexOf("app.listen(");
    const backgroundInit = indexSource.indexOf(
      "void initializeProductionSessionSigningInBackground()",
    );
    expect(listen).toBeGreaterThanOrEqual(0);
    expect(backgroundInit).toBeGreaterThan(listen);
    expect(indexSource).not.toContain(
      "await initializeProductionSessionSigningWithRetry()",
    );
  });

  it("retries transient production session initialization without terminating the server", () => {
    expect(indexSource).toContain("initializeProductionSessionSigningInBackground");
    expect(indexSource).toContain("server remains live and will retry");
    expect(indexSource).toContain("setTimeout(() =>");
    expect(indexSource).toContain("Math.min(");
    expect(indexSource).toContain("30_000");
    expect(indexSource).not.toContain("process.exit(1);\n}\n\nif (!isDevelopmentEnvironment())");
  });

  it("uses the canonical runtime database resolver when standalone session secrets are absent", () => {
    expect(authSource).toContain("process.env.BIZPORTAL_SESSION_SECRET");
    expect(authSource).toContain("process.env.SESSION_SECRET");
    expect(authSource).toContain("getRuntimeDatabaseUrl");
    expect(authSource).toContain("cst-bizportal:production-session:v1");
    expect(authSource).toContain("initializedProductionSessionSecret");
  });

  it("does not make production login depend on an optional GCP session-secret request", () => {
    const initStart = authSource.indexOf("export async function initializeProductionSessionSigning");
    const initSource = authSource.slice(initStart, authSource.indexOf("function getDevIdentitySecret", initStart));
    expect(initSource).toContain("getRuntimeDatabaseUrl()");
    expect(initSource).not.toContain("readSecret(");
    expect(initSource).not.toContain("getBundledProductionSessionSecret");
    expect(initSource).not.toContain("AbortController");
  });

  it("keeps authentication fail-closed at the request boundary", () => {
    const routeStart = localAuthSource.indexOf('router.post("/auth/email-login"');
    const routeEnd = localAuthSource.indexOf('router.get("/auth/admin/users-password-status"', routeStart);
    const emailLoginRoute = localAuthSource.slice(routeStart, routeEnd);
    const init = emailLoginRoute.indexOf("await initializeProductionSessionSigning()");
    const cookie = emailLoginRoute.indexOf("setProductionSessionCookie(response, session)");
    expect(init).toBeGreaterThanOrEqual(0);
    expect(cookie).toBeGreaterThan(init);
  });

  it("does not perform a redundant second database lookup after password verification", () => {
    const routeStart = localAuthSource.indexOf('router.post("/auth/email-login"');
    const routeEnd = localAuthSource.indexOf('router.post("/auth/email-otp/send"', routeStart);
    const emailLoginRoute = localAuthSource.slice(routeStart, routeEnd);
    expect(emailLoginRoute).not.toContain("getProductionUser(");
    expect(emailLoginRoute).toContain("setProductionSessionCookie(response, session)");
  });
});
