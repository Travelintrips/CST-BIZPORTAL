import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  new URL("../routes/gmail-invoice-source.ts", import.meta.url),
  "utf8",
);
const organizerSource = readFileSync(
  new URL("../lib/gmail-organization.ts", import.meta.url),
  "utf8",
);

describe("Gmail organization rules", () => {
  it("requests the scopes needed to read mail, backfill labels, and manage filters", () => {
    expect(routeSource).toContain(
      '"https://www.googleapis.com/auth/gmail.readonly"',
    );
    expect(routeSource).toContain(
      '"https://www.googleapis.com/auth/gmail.labels"',
    );
    expect(routeSource).toContain(
      '"https://www.googleapis.com/auth/gmail.settings.basic"',
    );
    expect(routeSource).toContain(
      '"https://www.googleapis.com/auth/gmail.modify"',
    );
    expect(routeSource).not.toContain(
      '"https://www.googleapis.com/auth/gmail.send"',
    );
  });

  it("keeps Gmail label application separate from OAuth and Sync Now", () => {
    expect(routeSource).toContain(
      '"/recon-classification/invoice-sources/gmail/organization-rules/apply"',
    );
    const callbackStart = routeSource.indexOf('"/recon-classification/invoice-sources/gmail/callback"');
    const syncStart = routeSource.indexOf('"/recon-classification/invoice-sources/gmail/sync"');
    const reviewStart = routeSource.indexOf('"/recon-classification/invoice-sources/gmail/candidates/:id/review"');
    expect(routeSource.slice(callbackStart, syncStart)).not.toContain("await provisionGmailOrganizationRules({");
    expect(routeSource.slice(syncStart, reviewStart)).not.toContain("await provisionGmailOrganizationRules({");
    expect(routeSource).toContain("gmail_label_id=coalesce");
  });

  it("keeps the organizer non-destructive while sender labels are backfilled", () => {
    expect(organizerSource).toContain(
      "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    );
    expect(organizerSource).toContain(
      "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters",
    );
    expect(organizerSource).toContain(
      "autoOrganizeGmailInboxBySender",
    );
    expect(organizerSource).not.toContain("removeLabelIds");
    expect(organizerSource).not.toContain('"DELETE"');
  });

  it("runs sender organization only through manual Apply Labels", () => {
    expect(routeSource).toContain("await provisionGmailOrganizationRules({");
    expect(routeSource).toContain('"/recon-classification/invoice-sources/gmail/sync"');
    expect(routeSource).toContain('"/recon-classification/invoice-sources/gmail/organization-rules/apply"');
    expect(routeSource).not.toContain("runGmailOrganizerTick");
    expect(routeSource).not.toContain("GMAIL_ORGANIZER_POLL_MS");
    expect(routeSource).not.toContain("setInterval(");
  });
});
