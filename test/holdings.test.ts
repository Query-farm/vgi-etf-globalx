// Archetype proof for globalx.holdings: the CSV parser (quoted numbers, header-driven columns),
// the as-of extraction, weight-descending sort, and the three-strategy fetchHoldings URL discovery
// (as-of hint → fund-page link → business-day walk-back). SDK-free (no @query-farm import).

import { test, expect } from "bun:test";
import {
  parseCsv,
  parseHoldings,
  holdingsLinkFromHtml,
  fetchHoldings,
  holdingsCsvUrl,
  fundPageUrl,
  epochToYmd,
} from "../src/globalx.js";
import {
  FakeGlobalx,
  equityHoldingsCsv,
  bondHoldingsCsv,
  fundPageHtml,
} from "./fake-globalx.js";

test("holdingsCsvUrl / fundPageUrl lower-case the ticker into the path", () => {
  expect(holdingsCsvUrl("QYLD", "20260708")).toBe(
    "https://assets.globalxetfs.com/funds/holdings/qyld_full-holdings_20260708.csv",
  );
  expect(fundPageUrl("QYLD")).toBe("https://www.globalxetfs.com/funds/qyld/");
});

test("epochToYmd formats epoch seconds as YYYYMMDD (UTC)", () => {
  expect(epochToYmd(Math.floor(Date.UTC(2026, 6, 8) / 1000))).toBe("20260708");
  expect(epochToYmd(new Date(Date.UTC(2026, 0, 3)))).toBe("20260103");
});

test("parseCsv handles quoted fields with embedded commas and CRLF", () => {
  const rows = parseCsv('a,b,c\r\n1,"2,345.00","x"\r\n');
  expect(rows[0]).toEqual(["a", "b", "c"]);
  expect(rows[1]).toEqual(["1", "2,345.00", "x"]);
});

test("parseHoldings maps an equity CSV, sorts by weight desc, and drops the footer", () => {
  const rows = parseHoldings(equityHoldingsCsv(), "QYLD");
  // 4 constituents (incl. cash + a negative-weight option); the disclaimer footer is excluded.
  expect(rows.length).toBe(4);
  expect(rows.map((r) => r.weightPercent)).toEqual([0.74, 0.71, 0.01, -0.14]); // weight-descending
  const top = rows[0]!;
  expect(top.fundTicker).toBe("QYLD");
  expect(top.ticker).toBe("GILD");
  expect(top.name).toBe("GILEAD SCIENCES INC");
  expect(top.sedol).toBe("2369174");
  expect(top.marketPrice).toBe(135.82);
  expect(top.sharesHeld).toBe(450716); // "450,716.00" → 450716
  expect(top.marketValue).toBeCloseTo(61216247.12, 2);
  expect(top.asOfDate).toBe(Math.floor(Date.UTC(2026, 6, 8) / 1000));
  // A cash/derivative line has a blank constituent ticker → null.
  expect(rows[2]!.ticker).toBeNull();
});

test("parseHoldings maps a fixed-income CSV (same layout, blank tickers)", () => {
  const rows = parseHoldings(bondHoldingsCsv(), "EMBD");
  expect(rows.length).toBe(2);
  expect(rows[0]!.name).toBe("BRAZIL 7 1/4 01/12/56");
  expect(rows[0]!.ticker).toBeNull();
  expect(rows[0]!.weightPercent).toBe(0.73);
});

test("parseHoldings returns [] when there is no header row", () => {
  expect(parseHoldings("junk\nmore junk\n", "X")).toEqual([]);
  expect(parseHoldings("", "X")).toEqual([]);
});

test("holdingsLinkFromHtml extracts the dated CSV link from fund-page HTML", () => {
  const html = fundPageHtml("QYLD", "20260708");
  expect(holdingsLinkFromHtml(html, "QYLD")).toBe(
    "https://assets.globalxetfs.com/funds/holdings/qyld_full-holdings_20260708.csv",
  );
  expect(holdingsLinkFromHtml("<html></html>", "QYLD")).toBeNull();
});

test("fetchHoldings strategy 1: the as-of hint builds the dated URL directly (one fetch)", async () => {
  const asOf = Math.floor(Date.UTC(2026, 6, 8) / 1000);
  const fake = new FakeGlobalx((url) => {
    if (url === holdingsCsvUrl("QYLD", "20260708")) return equityHoldingsCsv();
    throw new Error(`404 ${url}`);
  });
  const rows = await fetchHoldings(fake.get, "QYLD", { asOfHint: asOf });
  expect(rows.length).toBe(4);
  expect(fake.calls).toEqual([holdingsCsvUrl("QYLD", "20260708")]);
});

test("fetchHoldings strategy 2: falls back to the fund-page link when the hint misses", async () => {
  const fake = new FakeGlobalx((url) => {
    if (url === fundPageUrl("QYLD")) return fundPageHtml("QYLD", "20260707");
    if (url === holdingsCsvUrl("QYLD", "20260707")) return equityHoldingsCsv("07/07/2026");
    throw new Error(`404 ${url}`);
  });
  // Hint points at a day whose CSV 404s; the fund page then reveals the real dated URL.
  const rows = await fetchHoldings(fake.get, "QYLD", {
    asOfHint: Math.floor(Date.UTC(2026, 6, 8) / 1000),
  });
  expect(rows.length).toBe(4);
  expect(fake.calls).toContain(fundPageUrl("QYLD"));
  expect(fake.calls).toContain(holdingsCsvUrl("QYLD", "20260707"));
});

test("fetchHoldings strategy 3: walks back business days when hint + page both miss", async () => {
  const fake = new FakeGlobalx((url) => {
    if (url === holdingsCsvUrl("QYLD", "20260706")) return equityHoldingsCsv("07/06/2026");
    throw new Error(`404 ${url}`); // fund page + all other days 404
  });
  const rows = await fetchHoldings(fake.get, "QYLD", {
    today: new Date(Date.UTC(2026, 6, 8)),
    lookbackDays: 5,
  });
  expect(rows.length).toBe(4);
  expect(fake.calls).toContain(holdingsCsvUrl("QYLD", "20260706"));
});

test("fetchHoldings returns [] for a fund with no published holdings file", async () => {
  const fake = new FakeGlobalx((url) => {
    throw new Error(`404 ${url}`);
  });
  const rows = await fetchHoldings(fake.get, "NOPE", {
    today: new Date(Date.UTC(2026, 6, 8)),
    lookbackDays: 3,
  });
  expect(rows).toEqual([]);
});
