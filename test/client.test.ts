// Cache behavior of the real client's `get`. The client is otherwise verified live, but the 24 h
// Explore-page memoization is pure logic, so it's unit-tested here with an injected fetch
// (call-counting) and an injected clock. No network.

import { test, expect } from "bun:test";
import { makeGlobalxClient, parseRetryAfter } from "../src/client.js";
import { EXPLORE_URL, holdingsCsvUrl } from "../src/globalx.js";

/** A fake fetch that counts calls and returns a canned text body. */
function countingFetch(body = "<html>ok</html>") {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      text: async () => body,
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

const CSV_URL = holdingsCsvUrl("QYLD", "20260708");

test("the Explore page is fetched once then served from cache within the TTL", async () => {
  const { impl, calls } = countingFetch();
  let clock = 1_000_000;
  const { get } = makeGlobalxClient(impl, { now: () => clock });
  await get(EXPLORE_URL);
  await get(EXPLORE_URL);
  clock += 60 * 60 * 1000; // +1 h, still within the 24 h TTL
  await get(EXPLORE_URL);
  expect(calls.length).toBe(1);
});

test("the Explore page is refetched after the TTL expires", async () => {
  const { impl, calls } = countingFetch();
  let clock = 0;
  const { get } = makeGlobalxClient(impl, { now: () => clock });
  await get(EXPLORE_URL);
  clock += 24 * 60 * 60 * 1000 + 1; // just past 24 h
  await get(EXPLORE_URL);
  expect(calls.length).toBe(2);
});

test("concurrent first Explore requests coalesce into a single fetch", async () => {
  const { impl, calls } = countingFetch();
  const { get } = makeGlobalxClient(impl);
  await Promise.all([get(EXPLORE_URL), get(EXPLORE_URL), get(EXPLORE_URL)]);
  expect(calls.length).toBe(1);
});

test("catalogCacheMs: 0 disables caching", async () => {
  const { impl, calls } = countingFetch();
  const { get } = makeGlobalxClient(impl, { catalogCacheMs: 0 });
  await get(EXPLORE_URL);
  await get(EXPLORE_URL);
  expect(calls.length).toBe(2);
});

test("holdings CSVs are never cached", async () => {
  const { impl, calls } = countingFetch("csv");
  const { get } = makeGlobalxClient(impl);
  await get(CSV_URL);
  await get(CSV_URL);
  expect(calls.length).toBe(2);
});

test("a failed Explore fetch is evicted so the next call retries", async () => {
  const calls: string[] = [];
  let failNext = true;
  const impl = (async (url: string) => {
    calls.push(url);
    if (failNext) {
      failNext = false;
      return { ok: false, status: 503, text: async () => "down" } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => "<html>ok</html>" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  const { get } = makeGlobalxClient(impl, { maxAttempts: 1 }); // isolate eviction from retry
  await expect(get(EXPLORE_URL)).rejects.toThrow(/HTTP 503/);
  const ok = await get(EXPLORE_URL); // cache was evicted → retries and succeeds
  expect(ok).toBe("<html>ok</html>");
  expect(calls.length).toBe(2);
});

/** A fake fetch that answers the scripted statuses in order (then 200), recording each call. */
function scriptedFetch(statuses: Array<{ status: number; retryAfter?: string }>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const next = statuses.shift();
    if (!next) return { ok: true, status: 200, headers: new Headers(), text: async () => "ok" } as unknown as Response;
    const headers = new Headers(next.retryAfter ? { "Retry-After": next.retryAfter } : {});
    return { ok: false, status: next.status, headers, text: async () => "slow down" } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { impl, calls };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

test("429 and 503 are retried with exponential backoff, then succeed", async () => {
  const { impl, calls } = scriptedFetch([{ status: 429 }, { status: 503 }]);
  const { waits, sleep } = recordingSleep();
  const { get } = makeGlobalxClient(impl, { sleep, retryBaseMs: 100 });
  expect(await get(CSV_URL)).toBe("ok");
  expect(calls.length).toBe(3);
  expect(waits).toEqual([100, 200]);
});

test("Retry-After (seconds) is honored and capped at maxRetryDelayMs", async () => {
  const { impl } = scriptedFetch([{ status: 429, retryAfter: "3" }, { status: 429, retryAfter: "120" }]);
  const { waits, sleep } = recordingSleep();
  const { get } = makeGlobalxClient(impl, { sleep, maxRetryDelayMs: 10_000 });
  expect(await get(CSV_URL)).toBe("ok");
  expect(waits).toEqual([3000, 10_000]);
});

test("retries are bounded: a persistent 429 fails after maxAttempts with the status kept", async () => {
  const { impl, calls } = scriptedFetch(Array.from({ length: 10 }, () => ({ status: 429 })));
  const { waits, sleep } = recordingSleep();
  const { get } = makeGlobalxClient(impl, { sleep, maxAttempts: 3, retryBaseMs: 1 });
  await expect(get(CSV_URL)).rejects.toThrow(/HTTP 429 .* after 3 attempts/);
  expect(calls.length).toBe(3);
  expect(waits.length).toBe(2);
});

test("other non-2xx statuses are not retried", async () => {
  const { impl, calls } = scriptedFetch([{ status: 404 }]);
  const { waits, sleep } = recordingSleep();
  const { get } = makeGlobalxClient(impl, { sleep });
  await expect(get(CSV_URL)).rejects.toThrow(/HTTP 404/);
  expect(calls.length).toBe(1);
  expect(waits).toEqual([]);
});

test("parseRetryAfter reads delta-seconds and HTTP dates", () => {
  expect(parseRetryAfter(null)).toBeNull();
  expect(parseRetryAfter("")).toBeNull();
  expect(parseRetryAfter("garbage")).toBeNull();
  expect(parseRetryAfter("5")).toBe(5000);
  const now = Date.parse("2026-11-14T12:00:00Z");
  expect(parseRetryAfter("Sat, 14 Nov 2026 12:00:07 GMT", now)).toBe(7000);
  expect(parseRetryAfter("Sat, 14 Nov 2026 11:00:00 GMT", now)).toBe(0);
});
