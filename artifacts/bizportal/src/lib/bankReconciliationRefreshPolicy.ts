/**
 * Only an active/just-submitted matching job needs a timer. Bank mutation
 * lists, QRIS reviews, summaries and journals are refreshed by explicit
 * query invalidations and initial mount, never by this interval.
 */
export const MATCHING_STATUS_POLL_INTERVAL_MS = 5_000;

export function matchingStatusPollInterval(
  status: { running?: boolean } | undefined,
  awaitingStart: boolean,
): number | false {
  return awaitingStart || status?.running === true
    ? MATCHING_STATUS_POLL_INTERVAL_MS
    : false;
}

export function shouldRefreshOnMatchingTerminal(
  status: "idle" | "running" | "completed" | "failed" | undefined,
  previousRunning: boolean,
  awaitingStart: boolean,
): boolean {
  return (previousRunning || awaitingStart)
    && (status === "completed" || status === "failed");
}
