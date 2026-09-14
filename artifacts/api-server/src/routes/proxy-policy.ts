import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";

const COOKIE_PREFIX = "bizportal_upstream_";
const FORWARDED_HEADERS = [
  "accept",
  "accept-language",
  "content-type",
  "user-agent",
  "x-requested-with",
] as const;

export function validateUpstreamOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/") {
    throw new Error("BIZPORTAL_API_ORIGIN must be an HTTPS origin without credentials or a path");
  }
  return url;
}

export function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  upstream: URL,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = { host: upstream.host };
  for (const name of FORWARDED_HEADERS) {
    const value = incoming[name];
    if (value !== undefined) {
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }

  const upstreamCookies = (incoming.cookie ?? "")
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.startsWith(COOKIE_PREFIX))
    .map((cookie) => cookie.slice(COOKIE_PREFIX.length));
  if (upstreamCookies.length > 0) headers.cookie = upstreamCookies.join("; ");

  headers.origin = upstream.origin;
  headers.referer = `${upstream.origin}/`;
  return headers;
}

export function rewriteSetCookies(cookies: string[] | undefined): string[] | undefined {
  return cookies?.map((cookie) => {
    const withoutDomain = cookie.replace(/;\s*Domain=[^;]+/gi, "");
    return withoutDomain.replace(/^([^=]+)=/, `${COOKIE_PREFIX}$1=`);
  });
}