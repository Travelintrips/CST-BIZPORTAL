import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import {
  getDevIdentitySignature,
  isDevelopmentEnvironment,
  type DevAuthUser,
} from "./dev-auth";

const COOKIE_PREFIX = "bizportal_upstream_";
const PRODUCTION_UPSTREAM_HOST = "cstlogistic.co.id";
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

export function validateUpstreamBaseUrl(
  value: string,
  options: { allowLocalHttp?: boolean } = {},
): URL {
  const url = new URL(value);
  const isLocalDevelopmentHttp =
    (options.allowLocalHttp === true || isDevelopmentEnvironment())
    && url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (
    (!isLocalDevelopmentHttp && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "BIZPORTAL_API_ORIGIN must be an HTTPS URL without credentials, query, or hash "
      + "(or a localhost HTTP URL in development)",
    );
  }
  return url;
}

export function buildUpstreamUrl(originalUrl: string, upstream: URL): URL {
  const request = new URL(originalUrl, "http://local-request");
  const basePath = upstream.pathname === "/" ? "" : upstream.pathname.replace(/\/+$/, "");
  const requestPath = request.pathname || "/";
  const pathAlreadyIncluded =
    !basePath || requestPath === basePath || requestPath.startsWith(`${basePath}/`);
  const pathname = pathAlreadyIncluded ? requestPath : `${basePath}${requestPath}`;
  const target = new URL(upstream.origin);
  target.pathname = pathname || "/";
  target.search = request.search;
  return target;
}

export function buildUpstreamHeaders(
  incoming: IncomingHttpHeaders,
  upstream: URL,
  devUser?: DevAuthUser | null,
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

  // The staging backend can authenticate the local session with a shared HMAC.
  // The source environment is the security boundary: this must never be sent
  // by production, even if an incoming request contains forged dev headers.
  const identitySignature = devUser ? getDevIdentitySignature(devUser) : null;
  if (
    devUser &&
    identitySignature &&
    isDevelopmentEnvironment() &&
    process.env.BIZPORTAL_DEV_FORWARD_IDENTITY !== "false" &&
    upstream.hostname !== PRODUCTION_UPSTREAM_HOST
  ) {
    headers["x-bizportal-dev-user"] = devUser.email;
    headers["x-bizportal-dev-role"] = devUser.role;
    headers["x-bizportal-dev-signature"] = identitySignature;
  }

  return headers;
}

export function rewriteSetCookies(cookies: string[] | undefined): string[] | undefined {
  return cookies?.map((cookie) => {
    const withoutDomain = cookie.replace(/;\s*Domain=[^;]+/gi, "");
    return withoutDomain.replace(/^([^=]+)=/, `${COOKIE_PREFIX}$1=`);
  });
}