// Archetype proof for globalx.products: the Explore-page flight-payload driver. Imports ONLY our
// own src + the fake — NO @query-farm/* — so it runs without the SDK installed. Proves flight
// chunk concatenation + JSON-unescape, the $ref / $D-date / $undefined resolution, fraction→
// percent-points conversion for returns, ticker narrowing, and the Explore URL contract.

import { test, expect } from "bun:test";
import {
  parseProducts,
  fetchProducts,
  resolveTicker,
  extractFlightText,
  flightRecords,
  parseDate,
  EXPLORE_URL,
} from "../src/globalx.js";
import {
  FakeGlobalx,
  exploreHtml,
  flightPayload,
  QYLD_FUND,
  EMBD_FUND,
} from "./fake-globalx.js";

const HTML = () => exploreHtml([QYLD_FUND, EMBD_FUND]);

test("parseDate handles ISO, ISO-datetime, and US-slash forms", () => {
  const jul8 = Math.floor(Date.UTC(2026, 6, 8) / 1000);
  expect(parseDate("2026-07-08")).toBe(jul8);
  expect(parseDate("2026-07-08T00:00:00.000Z")).toBe(jul8);
  expect(parseDate("07/08/2026")).toBe(jul8);
  expect(parseDate("")).toBeNull();
  expect(parseDate("garbage")).toBeNull();
});

test("extractFlightText concatenates the split push chunks and unescapes them", () => {
  const text = extractFlightText(HTML());
  // The raw flight text round-trips despite being split across two push() calls.
  expect(text).toContain(flightPayload([QYLD_FUND, EMBD_FUND]).slice(0, 40));
  const records = flightRecords(text);
  expect(records.size).toBeGreaterThan(4);
});

test("extractFlightText returns '' when there is no flight payload", () => {
  expect(extractFlightText("<html><body>nothing here</body></html>")).toBe("");
  expect(parseProducts("<html></html>")).toEqual([]);
});

test("parseProducts resolves references and maps the flight records to product rows", () => {
  const rows = parseProducts(HTML());
  expect(rows.length).toBe(2);
  const qyld = rows.find((r) => r.ticker === "QYLD")!;
  expect(qyld.fundName).toBe("Nasdaq 100® Covered Call ETF");
  expect(qyld.theme).toBe("Equity");
  expect(qyld.subTheme).toBe("Income");
  expect(qyld.nav).toBe(18.13);
  expect(qyld.netAssets).toBe(8224970185.9);
  expect(qyld.grossExpenseRatioPercent).toBe(0.6); // already percent points, unscaled
  expect(qyld.netExpenseRatioPercent).toBeNull(); // $undefined → null
  expect(qyld.inceptionDate).toBe(Math.floor(Date.UTC(2013, 11, 11) / 1000));
  expect(qyld.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 8) / 1000));
  expect(qyld.performanceAsOf).toBe(Math.floor(Date.UTC(2026, 5, 30) / 1000));
  // Returns arrive as fractions and are scaled to percent points.
  expect(qyld.return1yPercent).toBeCloseTo(24.3007604, 5);
  expect(qyld.ytdReturnPercent).toBeCloseTo(10.7907947, 5);
  expect(qyld.returnSinceInceptionPercent).toBeCloseTo(8.8749296, 5);
  expect(qyld.factSheetUrl).toContain("Fact-Sheet_QYLD.pdf");
});

test("parseProducts maps the fixed-income fund with a numeric net expense ratio", () => {
  const embd = parseProducts(HTML()).find((r) => r.ticker === "EMBD")!;
  expect(embd.theme).toBe("Fixed Income");
  expect(embd.netExpenseRatioPercent).toBe(0.39);
  expect(embd.return1yPercent).toBeCloseTo(8.4, 5);
});

test("parseProducts narrows to a single ticker (case-insensitive)", () => {
  const one = parseProducts(HTML(), "qyld");
  expect(one.length).toBe(1);
  expect(one[0]!.ticker).toBe("QYLD");
  expect(parseProducts(HTML(), "ZZZZ")).toEqual([]);
});

test("fetchProducts hits the Explore URL once", async () => {
  const fake = new FakeGlobalx(() => HTML());
  const rows = await fetchProducts(fake.get);
  expect(rows.length).toBe(2);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]).toBe(EXPLORE_URL);
});

test("resolveTicker canonicalizes a ticker and returns null on a miss", async () => {
  const fake = new FakeGlobalx(() => HTML());
  expect(await resolveTicker(fake.get, "qyld")).toBe("QYLD");
  expect(await resolveTicker(fake.get, "ZZZZ")).toBeNull();
});
