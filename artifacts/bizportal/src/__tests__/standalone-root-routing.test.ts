import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) =>
  readFileSync(path.resolve(root, relative), "utf8");

describe("standalone root routing contract", () => {
  it("uses / as the default Vite base path", () => {
    const vite = read("vite.config.ts");
    expect(vite).toContain("const defaultBasePath = '/';");
    expect(vite).not.toContain("const defaultBasePath = '/bizportal/';");
  });

  it("redirects legacy /bizportal URLs back to root routes", () => {
    const app = read("src/App.tsx");
    expect(app).toContain('const legacyPrefix = "/bizportal";');
    expect(app).not.toContain('window.location.replace("/bizportal/")');
  });

  it("uses root fallback for auth callbacks", () => {
    expect(read("src/pages/auth-callback.tsx")).toContain('|| "/";');
    expect(read("src/contexts/SupabaseAuthContext.tsx")).toContain('|| "/";');
  });

  it("does not retain legacy internal navigation prefixes in core navigation", () => {
    const files = [
      "src/components/layout/AppShell.tsx",
      "src/components/layout/DevUserSwitcher.tsx",
      "src/components/layout/NotificationBell.tsx",
      "src/pages/notifications.tsx",
      "src/hooks/useOrderNotifications.ts",
    ];
    for (const file of files) {
      expect(read(file)).not.toMatch(/["'`]\/bizportal(?:\/|["'`])/);
    }
  });
});
