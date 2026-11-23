import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FetchFn } from "../services/calendars/types";

/**
 * Guard for requests to URLs that users supply (webhooks, ICS feeds).
 *
 * Private network targets stay allowed (internal tools are a supported use case, see SECURITY.md), but
 * cloud metadata services and other link-local addresses are always blocked, however the address is
 * spelled (IPv4-mapped IPv6, DNS names that resolve to it, redirects that point at it).
 */

/** Resolve a hostname to its IP addresses. Injectable so tests never touch real DNS. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

export const defaultResolveHost: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export class BlockedUrlError extends Error {}

const BLOCKED_HOSTNAMES = new Set(["metadata", "metadata.google.internal"]);

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  return nums.every((n, i) => /^\d{1,3}$/.test(parts[i]) && n <= 255) ? nums : null;
}

/** Expand an IPv6 address into 8 hextets (handles "::" and a trailing dotted IPv4 part). */
function ipv6Hextets(ip: string): number[] | null {
  let addr = ip.toLowerCase().split("%")[0];
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (v4) {
    const o = ipv4Octets(v4[1]);
    if (!o) return null;
    addr = addr.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail, extra] = addr.split("::");
  if (extra !== undefined) return null;
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 0) return null;
  const all = [...left, ...Array(tail === undefined ? 0 : missing).fill("0"), ...right];
  const nums = all.map((h) => parseInt(h, 16));
  return nums.length === 8 && nums.every((n, i) => /^[0-9a-f]{1,4}$/.test(all[i]) && n <= 0xffff) ? nums : null;
}

function blockedIpv4(o: number[]): boolean {
  return (
    o[0] === 0 || // "this network"; 0.0.0.0 reaches the local host
    (o[0] === 169 && o[1] === 254) || // link-local, including 169.254.169.254 (AWS, GCP, Azure, OpenStack metadata)
    (o[0] === 100 && o[1] === 100 && o[2] === 100 && o[3] === 200) // Alibaba Cloud metadata
  );
}

/** True for addresses user-supplied URLs must never reach. */
export function isBlockedIp(ip: string): boolean {
  const v4 = ipv4Octets(ip);
  if (v4) return blockedIpv4(v4);
  const h = ipv6Hextets(ip);
  if (!h) return true; // unparseable: refuse rather than guess
  if (h.every((x) => x === 0)) return true; // ::
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (h[0] === 0xfd00 && h[1] === 0x0ec2 && h.slice(2, 7).every((x) => x === 0) && h[7] === 0x254) return true; // AWS IPv6 metadata
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms.
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) {
    return blockedIpv4([h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff]);
  }
  return false;
}

/** Synchronous checks on the URL itself: scheme, credentials and literal addresses. */
export function checkUrlShape(raw: string | URL): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new BlockedUrlError("URL must use http or https");
  if (url.username || url.password) throw new BlockedUrlError("Do not put credentials in the URL");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host) || (isIP(host) && isBlockedIp(host))) throw new BlockedUrlError("URL points to a blocked address");
  return url;
}

/** Full check including DNS. A name that does not resolve is allowed through: the request itself will fail. */
export async function assertAllowedUrl(raw: string | URL, resolveHost: ResolveHost): Promise<URL> {
  const url = checkUrlShape(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return url;
  let addresses: string[];
  try {
    addresses = await resolveHost(host);
  } catch {
    return url;
  }
  if (addresses.some(isBlockedIp)) throw new BlockedUrlError("URL points to a blocked address");
  return url;
}

export interface GuardedFetchOptions {
  timeoutMs?: number;
  /** Redirects to follow; each hop is checked again. 0 returns the 3xx response as is. */
  maxRedirects?: number;
}

/** fetch() for user-supplied URLs. Throws BlockedUrlError for blocked targets. */
export async function guardedFetch(
  fetchFn: FetchFn,
  resolveHost: ResolveHost,
  raw: string,
  init: RequestInit = {},
  opts: GuardedFetchOptions = {},
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 0;
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 10_000);
  let url = await assertAllowedUrl(raw, resolveHost);
  for (let hop = 0; ; hop++) {
    const res = await fetchFn(url.toString(), { ...init, redirect: "manual", signal });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location || hop >= maxRedirects) return res;
    url = await assertAllowedUrl(new URL(location, url), resolveHost);
    // A redirect turns the request into a plain GET, like browsers do for 301/302/303.
    if (res.status !== 307 && res.status !== 308) init = { ...init, method: "GET", body: undefined };
  }
}

/** Read a response body as text, refusing bodies larger than `maxBytes`. */
export async function readTextLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`Response is larger than ${Math.round(maxBytes / 1_000_000)} MB`);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response is larger than ${Math.round(maxBytes / 1_000_000)} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
