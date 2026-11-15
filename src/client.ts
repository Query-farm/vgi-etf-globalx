// The real Global X HTTP client — the ONE module that touches the network, so (like the sibling
// iShares/SPDR clients) it is exercised live, not by the unit tests, which drive the pure driver
// in globalx.ts through an injected `get`.
//
// Both Global X planes — the Explore catalog page and the per-fund holdings CSVs — are keyless
// and un-gated, and BOTH are plain text (HTML and CSV), so there is a single `get(url) => string`
// transport (no JSON, no binary). The one non-obvious requirement is a browser-like User-Agent;
// the default fetch UA is served an interstitial/blocked page instead of the content.
//
// EXPLORE CACHE: the ~1.2 MB Explore page backs `products` and every ticker resolution, and
// changes at most once a day. So the client memoizes just that one URL with a 24 h TTL (shared
// across queries in a long-lived stdio/HTTP process). Fund pages and holdings CSVs always go
// live. The in-flight Promise is cached (not only the resolved value) so concurrent first
// requests coalesce into one fetch; a failed fetch is evicted so the next call retries.
//
// RATE LIMITS: globalxetfs.com answers 429 (and occasionally 503) to bursts — notably from shared
// cloud/CI egress IPs. Those two statuses are retried with exponential backoff (honoring a
// Retry-After header, in seconds or as an HTTP date, capped at `maxRetryDelayMs`) for at most
// `maxAttempts` attempts in total; any other non-2xx fails at once. The final error keeps the
// "HTTP <status>" text so callers can tell a rate limit from a real failure.

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Default Explore-page cache lifetime: 24 hours. */
export const CATALOG_CACHE_MS = 24 * 60 * 60 * 1000;

type FetchLike = typeof globalThis.fetch;

/** The injected transport the table functions call: a text `get` (HTML or CSV). */
export interface GlobalxClient {
  get: (url: string) => Promise<string>;
}

export interface GlobalxClientOptions {
  /** Explore-page cache TTL in ms (default 24 h). Pass 0 to disable caching. */
  catalogCacheMs?: number;
  /** Injectable clock (ms since epoch) — for tests. Defaults to Date.now. */
  now?: () => number;
  /** Total attempts per request when Global X answers 429/503 (default 4; 1 disables retry). */
  maxAttempts?: number;
  /** First backoff delay in ms, doubled per retry (default 1000). */
  retryBaseMs?: number;
  /** Upper bound on any single wait, including a server-sent Retry-After (default 15000). */
  maxRetryDelayMs?: number;
  /** Injectable sleep — for tests. Defaults to a setTimeout promise. */
  sleep?: (ms: number) => Promise<void>;
}

/** HTTP statuses that mean "try again later" rather than "this request is wrong". */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/**
 * Parse a Retry-After header value into a delay in ms: either delta-seconds ("30") or an
 * HTTP date. Returns null when absent or unparseable. A date in the past yields 0.
 */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (value == null) return null;
  const v = value.trim();
  if (v === "") return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * Build the injectable `{ get }` client. `fetchImpl` defaults to the platform fetch; pass one in
 * for Cloudflare or to stub the network. The Explore page is memoized for `catalogCacheMs`
 * (default 24 h); fund pages and holdings CSVs are never cached.
 */
export function makeGlobalxClient(
  fetchImpl: FetchLike = globalThis.fetch,
  opts: GlobalxClientOptions = {},
): GlobalxClient {
  const ttl = opts.catalogCacheMs ?? CATALOG_CACHE_MS;
  const now = opts.now ?? (() => Date.now());
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const baseMs = opts.retryBaseMs ?? 1000;
  const capMs = opts.maxRetryDelayMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let catalog: { at: number; value: Promise<string> } | null = null;

  const rawGet = async (url: string): Promise<string> => {
    for (let attempt = 1; ; attempt++) {
      const res = await fetchImpl(url, { headers: { "User-Agent": UA } });
      if (res.ok) return res.text();
      const body = await res.text().catch(() => "");
      if (RETRYABLE_STATUSES.has(res.status) && attempt < maxAttempts) {
        const hinted = parseRetryAfter(res.headers?.get("retry-after") ?? null);
        const backoff = baseMs * 2 ** (attempt - 1);
        await sleep(Math.min(capMs, hinted ?? backoff));
        continue;
      }
      const tries = attempt > 1 ? ` after ${attempt} attempts` : "";
      throw new Error(`globalx: HTTP ${res.status} for ${url}${tries} — ${body.slice(0, 200)}`);
    }
  };

  const get = async (url: string): Promise<string> => {
    if (ttl > 0 && url.endsWith("/explore")) {
      const t = now();
      if (!catalog || t - catalog.at >= ttl) {
        const value = rawGet(url);
        catalog = { at: t, value };
        value.catch(() => {
          if (catalog && catalog.value === value) catalog = null;
        });
      }
      return catalog.value;
    }
    return rawGet(url);
  };

  return { get };
}

/** Convenience: the real client's `get` for wiring into the table functions. */
export function makeGlobalxGet(): (url: string) => Promise<string> {
  return makeGlobalxClient().get;
}
