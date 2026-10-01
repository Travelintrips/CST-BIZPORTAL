import { db } from "@workspace/db";
import { notificationLogsTable } from "@workspace/db/schema";
import { and, eq, gte, sql } from "drizzle-orm";
import { createHash } from "crypto";
import { logger } from "./logger.js";

const DEDUP_WINDOW_MS = parseInt(process.env.WA_DEDUP_WINDOW_MS ?? "1800000", 10);

function computeDedupKey(
  channel: string,
  recipient: string,
  context: string,
  refId: string,
): string {
  const bucket = Math.floor(Date.now() / DEDUP_WINDOW_MS);
  return createHash("sha256")
    .update(`${channel}:${recipient}:${context}:${refId}:${bucket}`)
    .digest("hex");
}

function fallbackRefId(message: string): string {
  return createHash("sha256").update(message).digest("hex");
}

export interface WaSendClaimInput {
  recipient: string;
  message: string;
  context?: string;
  refType?: string;
  refId?: string;
  mediaUrl?: string;
}

export interface WaSendClaimResult {
  claimed: boolean;
  logId?: number;
}

/**
 * Reserve one logical WA delivery before calling the provider.
 *
 * The UNIQUE dedup_key constraint makes this an atomic claim across processes.
 * When refId is absent, a hash of the message body becomes the logical ref,
 * so identical content to the same recipient is also protected.
 */
export async function claimWaSend(input: WaSendClaimInput): Promise<WaSendClaimResult> {
  const context = input.context ?? "general";
  const refId = input.refId ?? fallbackRefId(input.message);
  const dedupKey = computeDedupKey("wa", input.recipient, context, refId);
  const leaseUntil = new Date(Date.now() + 5 * 60 * 1000);

  try {
    const since = new Date(Date.now() - DEDUP_WINDOW_MS);
    const recent = await db
      .select({ id: notificationLogsTable.id })
      .from(notificationLogsTable)
      .where(and(
        eq(notificationLogsTable.channel, "wa"),
        eq(notificationLogsTable.recipient, input.recipient),
        eq(notificationLogsTable.context, context),
        eq(notificationLogsTable.refId, refId),
        gte(notificationLogsTable.createdAt, since),
        sql`${notificationLogsTable.status} in ('queued','sent','failed','skipped')`,
      ))
      .limit(1);
    if (recent.length) return { claimed: false };

    const rows = await db
      .insert(notificationLogsTable)
      .values({
        channel: "wa",
        recipient: input.recipient,
        message: input.message.slice(0, 2000),
        status: "queued",
        context,
        refType: input.refType ?? null,
        refId,
        mediaUrl: input.mediaUrl ?? null,
        dedupKey,
        nextRetryAt: leaseUntil,
      })
      .onConflictDoNothing({ target: notificationLogsTable.dedupKey })
      .returning({ id: notificationLogsTable.id });

    if (!rows.length) return { claimed: false };
    return { claimed: true, logId: rows[0]!.id };
  } catch (err) {
    logger.error({ err, context, refId, recipient: input.recipient }, "claimWaSend failed — blocking WA send");
    return { claimed: false };
  }
}

export async function finalizeWaSendClaim(
  logId: number,
  result: {
    status: "sent" | "failed" | "skipped";
    errorMsg?: string | null;
    waMessageId?: string;
    retryCount?: number;
    nextRetryAt?: Date | null;
  },
): Promise<void> {
  try {
    await db
      .update(notificationLogsTable)
      .set({
        status: result.status,
        errorMsg: result.errorMsg ?? null,
        retryCount: result.retryCount,
        nextRetryAt: result.nextRetryAt,
        waMessageId: result.waMessageId ?? null,
        waDeliveryStatus: result.waMessageId ? "sent" : null,
      })
      .where(eq(notificationLogsTable.id, logId));
  } catch (err) {
    logger.error({ err, logId, status: result.status }, "finalizeWaSendClaim failed");
  }
}

export interface LogNotifOptions {
  channel: "wa" | "email";
  recipient: string;
  subject?: string;
  message: string;
  status: "queued" | "sent" | "failed" | "deduped" | "simulated" | "skipped";
  errorMsg?: string;
  context?: string;
  refType?: string;
  refId?: string;
  mediaUrl?: string;
  waMessageId?: string;
}

export async function logNotification(opts: LogNotifOptions): Promise<void> {
  // Safe DEV/E2E sends are recorded as simulated, but they must still obey
  // the same logical delivery identity as real sends. Otherwise a duplicate
  // transition can create multiple simulated rows while production sends are
  // protected by the unique dedup key.
  const dedupKey =
    (opts.status === "sent" || opts.status === "simulated") && opts.context && opts.refId
      ? computeDedupKey(opts.channel, opts.recipient, opts.context, opts.refId)
      : null;

  try {
    await db
      .insert(notificationLogsTable)
      .values({
        channel: opts.channel,
        recipient: opts.recipient,
        subject: opts.subject ?? null,
        message: opts.message.slice(0, 2000),
        status: opts.status,
        errorMsg: opts.errorMsg ?? null,
        context: opts.context ?? "general",
        refType: opts.refType ?? null,
        refId: opts.refId ?? null,
        mediaUrl: opts.mediaUrl ?? null,
        dedupKey,
        waMessageId: opts.waMessageId ?? null,
        waDeliveryStatus: opts.waMessageId ? "sent" : null,
      })
      .onConflictDoNothing({ target: notificationLogsTable.dedupKey });
  } catch (err) {
    logger.error({ err }, "Failed to write notification log");
  }
}

export async function wasRecentlyNotified(
  context: string,
  refId: string,
  windowMs = 5 * 60 * 1000,
): Promise<boolean> {
  try {
    const since = new Date(Date.now() - windowMs);
    const rows = await db
      .select({ id: notificationLogsTable.id })
      .from(notificationLogsTable)
      .where(
        and(
          eq(notificationLogsTable.channel, "wa"),
          eq(notificationLogsTable.context, context),
          eq(notificationLogsTable.refId, refId),
          eq(notificationLogsTable.status, "sent"),
          gte(notificationLogsTable.createdAt, since),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch (err) {
    logger.warn({ err, context, refId }, "wasRecentlyNotified DB check failed — blocking send");
    return true;
  }
}
