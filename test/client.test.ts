// Cache behavior of the real client's `get`. The client is otherwise verified live, but the 24 h
// Explore-page memoization is pure logic, so it's unit-tested here with an injected fetch
// (call-counting) and an injected clock. No network.

import { test, expect } from "bun:test";
import { makeGlobalxClient } from "../src/client.js";
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
  const { get } = makeGlobalxClient(impl);
  await expect(get(EXPLORE_URL)).rejects.toThrow(/HTTP 503/);
  const ok = await get(EXPLORE_URL); // cache was evicted → retries and succeeds
  expect(ok).toBe("<html>ok</html>");
  expect(calls.length).toBe(2);
});
