export function preferPollingRealtime(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hostname === "bizportal.cstlogistic.co.id";
}
