import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexSource = readFileSync(resolve(process.cwd(), "src/index.ts"), "utf8");
const authSource = readFileSync(resolve(process.cwd(), "src/routes/dev-auth.ts"), "utf8");
const localAuthSource = readFileSync(resolve(process.cwd(), "src/routes/local-production-auth.ts"), "utf8");

describe("production auth startup contract", () => {
  it("initializes session signing before the server accepts traffic", () => {
    const init = indexSource.indexOf("await initializeProductionSessionSigning()");
    const listen = indexSource.indexOf("app.listen(");
    expect(init).toBeGreaterThanOrEqual(0);
    expect(listen).toBeGreaterThan(init);
  });

  it("uses the canonical runtime database resolver when standalone session secrets are absent", () => {
    expect(authSource).toContain('"BIZPORTAL_SESSION_SECRET", "SESSION_SECRET"');
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

  it("does not perform a redundant second database lookup after password verification", () => {
    const routeStart = localAuthSource.indexOf('router.post("/auth/email-login"');
    const routeEnd = localAuthSource.indexOf('router.post("/auth/email-otp/send"', routeStart);
    const emailLoginRoute = localAuthSource.slice(routeStart, routeEnd);
    expect(emailLoginRoute).not.toContain("getProductionUser(");
    expect(emailLoginRoute).toContain("setProductionSessionCookie(response, session)");
  });
});
