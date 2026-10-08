import { pool } from "@workspace/db";
import { autoOrganizeGmailInboxBySender } from "./gmail-sender-organizer";

type GmailLabel = {
  id?: string;
  name?: string;
  type?: string;
};

type GmailFilter = {
  id?: string;
  criteria?: {
    from?: string;
    subject?: string;
  };
  action?: {
    addLabelIds?: string[];
  };
};

export type GmailOrganizationRule = {
  id: number;
  companyId: number;
  labelName: string;
  fromPattern: string | null;
  subjectPattern: string | null;
  isActive: boolean;
  gmailLabelId: string | null;
  gmailFilterId: string | null;
  status: string;
  lastAppliedAt: string | Date | null;
  lastError: string | null;
};

function mapRule(row: Record<string, unknown>): GmailOrganizationRule {
  return {
    id: Number(row.id),
    companyId: Number(row.company_id),
    labelName: String(row.label_name ?? ""),
    fromPattern:
      typeof row.from_pattern === "string"
        ? row.from_pattern
        : null,
    subjectPattern:
      typeof row.subject_pattern === "string"
        ? row.subject_pattern
        : null,
    isActive: row.is_active !== false,
    gmailLabelId:
      typeof row.gmail_label_id === "string"
        ? row.gmail_label_id
        : null,
    gmailFilterId:
      typeof row.gmail_filter_id === "string"
        ? row.gmail_filter_id
        : null,
    status: String(row.status ?? "pending"),
    lastAppliedAt:
      (row.last_applied_at as string | Date | null) ?? null,
    lastError:
      typeof row.last_error === "string"
        ? row.last_error
        : null,
  };
}

export async function listGmailOrganizationRules(
  companyId: number,
): Promise<GmailOrganizationRule[]> {
  const result = await pool.query<Record<string, unknown>>(
    `select *
       from public.gmail_organization_rules
      where company_id=$1
      order by id`,
    [companyId],
  );
  return result.rows.map(mapRule);
}

async function gmailApi<T>(
  accessToken: string,
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const payload = (await response.json().catch(() => ({}))) as
    | T
    | { error?: { message?: string } };

  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : `Gmail API HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

async function ensureLabel(
  accessToken: string,
  labelName: string,
): Promise<{ id: string; created: boolean }> {
  const labels = await gmailApi<{ labels?: GmailLabel[] }>(
    accessToken,
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
  );

  const existing = (labels.labels ?? []).find(
    (label) =>
      String(label.name ?? "").trim().toLowerCase() ===
      labelName.trim().toLowerCase(),
  );

  if (existing?.id) {
    return { id: existing.id, created: false };
  }

  const created = await gmailApi<GmailLabel>(
    accessToken,
    "https://gmail.googleapis.com/gmail/v1/users/me/labels",
    {
      method: "POST",
      body: JSON.stringify({
        name: labelName,
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      }),
    },
  );

  if (!created.id) {
    throw new Error(
      `Gmail tidak mengembalikan ID label untuk ${labelName}.`,
    );
  }

  return { id: created.id, created: true };
}

function sameText(
  left: string | undefined,
  right: string | null,
): boolean {
  return String(left ?? "").trim().toLowerCase() ===
    String(right ?? "").trim().toLowerCase();
}

async function ensureFilter(
  accessToken: string,
  rule: GmailOrganizationRule,
  labelId: string,
): Promise<{ id: string; created: boolean }> {
  const filters = await gmailApi<{ filter?: GmailFilter[] }>(
    accessToken,
    "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters",
  );

  const existing = (filters.filter ?? []).find((filter) => {
    const labels = filter.action?.addLabelIds ?? [];
    return (
      labels.includes(labelId) &&
      sameText(filter.criteria?.from, rule.fromPattern) &&
      sameText(filter.criteria?.subject, rule.subjectPattern)
    );
  });

  if (existing?.id) {
    return { id: existing.id, created: false };
  }

  const criteria: Record<string, string> = {};
  if (rule.fromPattern?.trim()) {
    criteria.from = rule.fromPattern.trim();
  }
  if (rule.subjectPattern?.trim()) {
    criteria.subject = rule.subjectPattern.trim();
  }

  const created = await gmailApi<GmailFilter>(
    accessToken,
    "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters",
    {
      method: "POST",
      body: JSON.stringify({
        criteria,
        action: {
          addLabelIds: [labelId],
        },
      }),
    },
  );

  if (!created.id) {
    throw new Error(
      `Gmail tidak mengembalikan ID filter untuk label ${rule.labelName}.`,
    );
  }

  return { id: created.id, created: true };
}

async function markRule(
  ruleId: number,
  args: {
    labelId?: string | null;
    filterId?: string | null;
    status: string;
    error?: string | null;
    actorEmail: string;
  },
): Promise<void> {
  await pool.query(
    `update public.gmail_organization_rules
        set gmail_label_id=coalesce($2,gmail_label_id),
            gmail_filter_id=coalesce($3,gmail_filter_id),
            status=$4,
            last_applied_at=case when $4='active' then now() else last_applied_at end,
            last_error=$5,
            updated_by=$6,
            updated_at=now()
      where id=$1`,
    [
      ruleId,
      args.labelId ?? null,
      args.filterId ?? null,
      args.status,
      args.error ?? null,
      args.actorEmail,
    ],
  );
}

export async function provisionGmailOrganizationRules(args: {
  companyId: number;
  accessToken: string;
  actorEmail: string;
  senderScanLimit?: number;
}): Promise<{
  total: number;
  active: number;
  createdLabels: number;
  createdFilters: number;
  failed: number;
  senderScannedMessages: number;
  senderGroups: number;
  senderCreatedLabels: number;
  senderCreatedFilters: number;
  senderLabeledMessages: number;
  senderOrganizerError: string | null;
  rules: GmailOrganizationRule[];
}> {
  const rules = (
    await listGmailOrganizationRules(args.companyId)
  ).filter((rule) => rule.isActive);

  let active = 0;
  let createdLabels = 0;
  let createdFilters = 0;
  let failed = 0;

  for (const rule of rules) {
    try {
      const label = await ensureLabel(
        args.accessToken,
        rule.labelName,
      );
      if (label.created) createdLabels += 1;

      const filter = await ensureFilter(
        args.accessToken,
        rule,
        label.id,
      );
      if (filter.created) createdFilters += 1;

      await markRule(rule.id, {
        labelId: label.id,
        filterId: filter.id,
        status: "active",
        error: null,
        actorEmail: args.actorEmail,
      });
      active += 1;
    } catch (error) {
      failed += 1;
      await markRule(rule.id, {
        status: "error",
        error:
          error instanceof Error
            ? error.message.slice(0, 1000)
            : String(error).slice(0, 1000),
        actorEmail: args.actorEmail,
      });
    }
  }

  let senderScannedMessages = 0;
  let senderGroups = 0;
  let senderCreatedLabels = 0;
  let senderCreatedFilters = 0;
  let senderLabeledMessages = 0;
  let senderOrganizerError: string | null = null;

  try {
    const senderResult =
      await autoOrganizeGmailInboxBySender({
        accessToken: args.accessToken,
        scanLimit: args.senderScanLimit,
      });

    senderScannedMessages =
      senderResult.scannedMessages;
    senderGroups = senderResult.senderGroups;
    senderCreatedLabels =
      senderResult.createdLabels;
    senderCreatedFilters =
      senderResult.createdFilters;
    senderLabeledMessages =
      senderResult.labeledMessages;
  } catch (error) {
    senderOrganizerError =
      error instanceof Error
        ? error.message.slice(0, 1000)
        : String(error).slice(0, 1000);
    failed += 1;
  }

  return {
    total: rules.length,
    active,
    createdLabels,
    createdFilters,
    failed,
    senderScannedMessages,
    senderGroups,
    senderCreatedLabels,
    senderCreatedFilters,
    senderLabeledMessages,
    senderOrganizerError,
    rules: await listGmailOrganizationRules(args.companyId),
  };
}
