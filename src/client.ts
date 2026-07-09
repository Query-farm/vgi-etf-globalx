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
  let catalog: { at: number; value: Promise<string> } | null = null;

  const rawGet = async (url: string): Promise<string> => {
    const res = await fetchImpl(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`globalx: HTTP ${res.status} for ${url} — ${body.slice(0, 200)}`);
    }
    return res.text();
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
