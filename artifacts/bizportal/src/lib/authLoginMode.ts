export type EmailLoginMode = "dev" | "email";

export function resolveEmailLoginMode({
  email,
  password,
  devEmails,
}: {
  email: string;
  password: string;
  devEmails: readonly string[];
}): EmailLoginMode {
  const normalizedEmail = email.trim().toLowerCase();
  const isConfiguredDevEmail = devEmails.some(
    (devEmail) => devEmail.trim().toLowerCase() === normalizedEmail,
  );

  return !password && isConfiguredDevEmail ? "dev" : "email";
}