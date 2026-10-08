type GmailLabel = {
  id?: string;
  name?: string;
};

type GmailFilter = {
  id?: string;
  criteria?: {
    from?: string;
  };
  action?: {
    addLabelIds?: string[];
  };
};

type GmailMessageList = {
  messages?: Array<{ id?: string }>;
  nextPageToken?: string;
};

type GmailMessage = {
  id?: string;
  labelIds?: string[];
  payload?: {
    headers?: Array<{
      name?: string;
      value?: string;
    }>;
  };
};

type SenderMessage = {
  id: string;
  labelIds: string[];
};

type SenderGroup = {
  labelName: string;
  senders: Set<string>;
  messages: SenderMessage[];
};

export type GmailSenderOrganizerResult = {
  scannedMessages: number;
  senderGroups: number;
  createdLabels: number;
  createdFilters: number;
  labeledMessages: number;
};

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

function cleanLabelName(
  name: string,
  email: string,
): string {
  let value = name
    .replace(/^["']|["']$/g, "")
    .replace(/[\\/]+/g, " - ")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!value) {
    const domain = email.split("@")[1] ?? email;
    value = (domain.split(".")[0] ?? "Sender")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  const reserved = new Set([
    "inbox",
    "sent",
    "draft",
    "drafts",
    "spam",
    "trash",
    "starred",
    "important",
    "all mail",
  ]);

  if (reserved.has(value.toLowerCase())) {
    value = `Sender - ${value}`;
  }

  return value.slice(0, 180) || "Unknown Sender";
}

function parseFromHeader(
  value: string,
): {
  name: string;
  email: string;
} | null {
  const raw = value.trim();
  if (!raw) return null;

  const angle = raw.match(/^(.*?)<([^<>\s]+@[^<>\s]+)>\s*$/);
  if (angle) {
    const email = angle[2]!.trim().toLowerCase();
    const name = angle[1]!
      .trim()
      .replace(/^["']|["']$/g, "")
      .trim();

    return { name, email };
  }

  const emailMatch = raw.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  );
  if (!emailMatch) return null;

  const email = emailMatch[0]!.toLowerCase();
  const name = raw
    .replace(emailMatch[0]!, "")
    .replace(/[<>"]/g, "")
    .trim();

  return { name, email };
}

async function listInboxMessageIds(
  accessToken: string,
  limit: number,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (ids.length < limit) {
    const url = new URL(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    );
    url.searchParams.set(
      "maxResults",
      String(Math.min(100, limit - ids.length)),
    );
    url.searchParams.append("labelIds", "INBOX");

    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const payload = await gmailApi<GmailMessageList>(
      accessToken,
      url.toString(),
    );

    for (const message of payload.messages ?? []) {
      if (message.id) ids.push(message.id);
    }

    pageToken = payload.nextPageToken;
    if (!pageToken) break;
  }

  return ids.slice(0, limit);
}

async function readSenderMessage(
  accessToken: string,
  messageId: string,
): Promise<{
  labelName: string;
  senderEmail: string;
  message: SenderMessage;
} | null> {
  const url = new URL(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}`,
  );
  url.searchParams.set("format", "metadata");
  url.searchParams.append("metadataHeaders", "From");

  const message = await gmailApi<GmailMessage>(
    accessToken,
    url.toString(),
  );

  const from = (
    message.payload?.headers ?? []
  ).find(
    (header) =>
      String(header.name ?? "").toLowerCase() === "from",
  )?.value;

  const parsed = parseFromHeader(from ?? "");
  if (!parsed) return null;

  return {
    labelName: cleanLabelName(
      parsed.name,
      parsed.email,
    ),
    senderEmail: parsed.email,
    message: {
      id: messageId,
      labelIds: message.labelIds ?? [],
    },
  };
}

async function ensureLabelCached(
  accessToken: string,
  labelName: string,
  labelsByName: Map<string, GmailLabel>,
): Promise<{
  id: string;
  created: boolean;
}> {
  const key = labelName.trim().toLowerCase();
  const existing = labelsByName.get(key);

  if (existing?.id) {
    return {
      id: existing.id,
      created: false,
    };
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

  labelsByName.set(key, created);

  return {
    id: created.id,
    created: true,
  };
}

function filterKey(
  senderEmail: string,
  labelId: string,
): string {
  return `${senderEmail.trim().toLowerCase()}\u0000${labelId}`;
}

async function ensureSenderFilter(
  accessToken: string,
  senderEmail: string,
  labelId: string,
  filterKeys: Set<string>,
): Promise<boolean> {
  const key = filterKey(senderEmail, labelId);
  if (filterKeys.has(key)) return false;

  const created = await gmailApi<GmailFilter>(
    accessToken,
    "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters",
    {
      method: "POST",
      body: JSON.stringify({
        criteria: {
          from: senderEmail,
        },
        action: {
          addLabelIds: [labelId],
        },
      }),
    },
  );

  if (!created.id) {
    throw new Error(
      `Gmail tidak mengembalikan ID filter untuk ${senderEmail}.`,
    );
  }

  filterKeys.add(key);
  return true;
}

async function applyLabelToMessages(
  accessToken: string,
  messageIds: string[],
  labelId: string,
): Promise<number> {
  if (messageIds.length === 0) return 0;

  let applied = 0;

  for (
    let offset = 0;
    offset < messageIds.length;
    offset += 1000
  ) {
    const ids = messageIds.slice(
      offset,
      offset + 1000,
    );

    await gmailApi<Record<string, never>>(
      accessToken,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
      {
        method: "POST",
        body: JSON.stringify({
          ids,
          addLabelIds: [labelId],
        }),
      },
    );

    applied += ids.length;
  }

  return applied;
}

export async function autoOrganizeGmailInboxBySender(args: {
  accessToken: string;
  scanLimit?: number;
}): Promise<GmailSenderOrganizerResult> {
  const scanLimit = Math.min(
    Math.max(args.scanLimit ?? 500, 1),
    1000,
  );

  const messageIds = await listInboxMessageIds(
    args.accessToken,
    scanLimit,
  );

  const groups = new Map<string, SenderGroup>();

  for (
    let offset = 0;
    offset < messageIds.length;
    offset += 6
  ) {
    const batch = messageIds.slice(
      offset,
      offset + 6,
    );

    const rows = await Promise.all(
      batch.map((messageId) =>
        readSenderMessage(
          args.accessToken,
          messageId,
        ).catch(() => null),
      ),
    );

    for (const row of rows) {
      if (!row) continue;

      const key = row.labelName.toLowerCase();
      const group =
        groups.get(key) ??
        {
          labelName: row.labelName,
          senders: new Set<string>(),
          messages: [],
        };

      group.senders.add(row.senderEmail);
      group.messages.push(row.message);
      groups.set(key, group);
    }
  }

  const [labelsPayload, filtersPayload] =
    await Promise.all([
      gmailApi<{ labels?: GmailLabel[] }>(
        args.accessToken,
        "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      ),
      gmailApi<{ filter?: GmailFilter[] }>(
        args.accessToken,
        "https://gmail.googleapis.com/gmail/v1/users/me/settings/filters",
      ),
    ]);

  const labelsByName = new Map<
    string,
    GmailLabel
  >();

  for (const label of labelsPayload.labels ?? []) {
    const name = label.name?.trim();
    if (!name) continue;
    labelsByName.set(
      name.toLowerCase(),
      label,
    );
  }

  const filterKeys = new Set<string>();

  for (const filter of filtersPayload.filter ?? []) {
    const sender =
      filter.criteria?.from?.trim().toLowerCase();
    if (!sender) continue;

    for (
      const labelId of
      filter.action?.addLabelIds ?? []
    ) {
      filterKeys.add(
        filterKey(sender, labelId),
      );
    }
  }

  let createdLabels = 0;
  let createdFilters = 0;
  let labeledMessages = 0;

  const sortedGroups = Array.from(
    groups.values(),
  ).sort((left, right) =>
    left.labelName.localeCompare(
      right.labelName,
      "en",
      {
        sensitivity: "base",
      },
    ),
  );

  for (const group of sortedGroups) {
    const label = await ensureLabelCached(
      args.accessToken,
      group.labelName,
      labelsByName,
    );

    if (label.created) {
      createdLabels += 1;
    }

    for (const sender of group.senders) {
      if (
        await ensureSenderFilter(
          args.accessToken,
          sender,
          label.id,
          filterKeys,
        )
      ) {
        createdFilters += 1;
      }
    }

    const unlabeled = group.messages
      .filter(
        (message) =>
          !message.labelIds.includes(label.id),
      )
      .map((message) => message.id);

    labeledMessages +=
      await applyLabelToMessages(
        args.accessToken,
        unlabeled,
        label.id,
      );
  }

  return {
    scannedMessages: messageIds.length,
    senderGroups: groups.size,
    createdLabels,
    createdFilters,
    labeledMessages,
  };
}
