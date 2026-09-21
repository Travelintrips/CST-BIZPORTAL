import { describe, expect, it } from "vitest";
import { resolveEmailLoginMode } from "@/lib/authLoginMode";

describe("resolveEmailLoginMode", () => {
  it("uses the development login for an allowlisted email with no password", () => {
    expect(
      resolveEmailLoginMode({
        email: "  Admcst001@Gmail.com ",
        password: "",
        devEmails: ["admcst001@gmail.com"],
      }),
    ).toBe("dev");
  });

  it("keeps the email/password route when a password is supplied", () => {
    expect(
      resolveEmailLoginMode({
        email: "admcst001@gmail.com",
        password: "provided",
        devEmails: ["admcst001@gmail.com"],
      }),
    ).toBe("email");
  });

  it("keeps the email/password route for emails outside the development allowlist", () => {
    expect(
      resolveEmailLoginMode({
        email: "other@example.com",
        password: "",
        devEmails: ["admcst001@gmail.com"],
      }),
    ).toBe("email");
  });
});