// A tiny in-process fake of the Global X endpoints — enough to prove the driver: it records
// every requested URL (so a test can assert the wire contract) and returns canned text shaped
// like the real Explore page (a Next.js RSC flight payload), the per-fund page (carrying the
// holdings link), and the per-fund holdings CSV. No network.
//
// The driver takes ONE injected transport: `get(url) => Promise<string>` (text — HTML or CSV).

import { EXPLORE_URL, fundPageUrl, holdingsCsvUrl } from "../src/globalx.js";

export class FakeGlobalx {
  /** Every URL this fake was asked for, in order. */
  readonly calls: string[] = [];

  constructor(private readonly route: (url: string) => string) {}

  get = async (url: string): Promise<string> => {
    this.calls.push(url);
    return this.route(url);
  };
}

// ── Explore-page flight payload ──────────────────────────────────────────────────
//
// Reproduces the real shape: fund data lives in `self.__next_f.push([n,"…"])` string chunks whose
// concatenation is a set of newline-delimited `id:json` flight records with a reference system
// ($id → another record, $D… → a date, $undefined). Each fund contributes four records: an
// annualized-performance record, a cumulative-performance record, a fund-data record (referencing
// the two), and a catalog record (referencing the fund-data record).

export interface FakeFund {
  ticker: string;
  name: string;
  theme: string;
  subTheme: string;
  inception: string; // ISO date
  asOf: string; // ISO date
  monthEnd: string; // ISO date
  nav: number;
  netAssets: number;
  grossExp: number;
  netExp: number | null; // null → flight `$undefined`
  anl: { since_inception: number; year_1: number; year_3: number; year_5: number; year_10: number };
  cum: { month_1: number; month_3: number; ytd: number };
}

export const QYLD_FUND: FakeFund = {
  ticker: "QYLD",
  name: "Nasdaq 100® Covered Call ETF",
  theme: "Equity",
  subTheme: "Income",
  inception: "2013-12-11",
  asOf: "2026-07-08",
  monthEnd: "2026-06-30",
  nav: 18.13,
  netAssets: 8224970185.9,
  grossExp: 0.6,
  netExp: null,
  anl: { since_inception: 0.088749296, year_1: 0.243007604, year_3: 0.143883084, year_5: 0.087091285, year_10: 0.100742527 },
  cum: { month_1: 0.029680037, month_3: 0.107546437, ytd: 0.107907947 },
};

export const EMBD_FUND: FakeFund = {
  ticker: "EMBD",
  name: "Emerging Market Bond ETF",
  theme: "Fixed Income",
  subTheme: "Core",
  inception: "2020-07-14",
  asOf: "2026-07-08",
  monthEnd: "2026-06-30",
  nav: 21.44,
  netAssets: 192507985.24,
  grossExp: 0.39,
  netExp: 0.39,
  anl: { since_inception: 0.021, year_1: 0.084, year_3: 0.051, year_5: 0.019, year_10: 0.0 },
  cum: { month_1: 0.006, month_3: 0.021, ytd: 0.073 },
};

let idCounter = 0;
const nextId = () => (idCounter++).toString(36);

/** Build the newline-delimited flight text for a set of funds (with $-references and $D dates). */
export function flightPayload(funds: FakeFund[]): string {
  idCounter = 100; // avoid single-char ids colliding with anything
  const lines: string[] = ['0:"$L1"', "3:null"]; // a little realistic preamble noise
  for (const fn of funds) {
    const anlId = nextId();
    const cumId = nextId();
    const fdId = nextId();
    const catId = nextId();
    lines.push(`${anlId}:${JSON.stringify(fn.anl)}`);
    lines.push(`${cumId}:${JSON.stringify(fn.cum)}`);
    lines.push(
      `${fdId}:${JSON.stringify({
        anl_perf: `$${anlId}`,
        cum_perf: `$${cumId}`,
        etf_name: fn.name,
        etf_ticker: fn.ticker,
        inception_date: `$D${fn.inception}T00:00:00.000Z`,
        month_end_date: `$D${fn.monthEnd}T00:00:00.000Z`,
        nav: fn.nav,
        net_assets: fn.netAssets,
      })}`,
    );
    lines.push(
      `${catId}:${JSON.stringify({
        AS_OF_DATE: `$D${fn.asOf}T00:00:00.000Z`,
        ETF_TICKER: fn.ticker,
        FUND_DATA: `$${fdId}`,
        THEME: fn.theme,
        SUB_THEME: fn.subTheme,
        GROSS_EXP: fn.grossExp,
        NET_EXP: fn.netExp == null ? "$undefined" : fn.netExp,
        FACT_SHEET: `https://assets.globalxetfs.com/funds/documents/${fn.ticker.toLowerCase()}/Fact-Sheet_${fn.ticker}.pdf`,
      })}`,
    );
  }
  return lines.join("\n");
}

/**
 * Wrap flight text into an /explore HTML page. The flight payload is SPLIT across two
 * `self.__next_f.push([1,"…"])` calls (each independently JSON-escaped) to exercise the driver's
 * chunk-concatenation path. Also includes a skeleton `<table>` like the real (client-hydrated) one.
 */
export function exploreHtml(funds: FakeFund[]): string {
  const flight = flightPayload(funds);
  const mid = Math.floor(flight.length / 2);
  const push = (s: string) => `<script>self.__next_f.push([1,${JSON.stringify(s)}])</script>`;
  return (
    "<!doctype html><html><head><title>Explore</title></head><body>" +
    '<table class="table-fixed"><thead><tr><th>Ticker</th><th>ETF Name</th></tr></thead>' +
    '<tbody><tr><td><div class="animate-pulse"></div></td></tr></tbody></table>' +
    "<script>self.__next_f=self.__next_f||[]</script>" +
    push(flight.slice(0, mid)) +
    push(flight.slice(mid)) +
    "</body></html>"
  );
}

// ── per-fund page (carries the holdings CSV link) ────────────────────────────────

export function fundPageHtml(ticker: string, ymd: string): string {
  const url = holdingsCsvUrl(ticker, ymd);
  return (
    `<!doctype html><html><body><h1>${ticker}</h1>` +
    `<a href="${url}">Full Holdings (CSV)</a>` +
    `</body></html>`
  );
}

// ── per-fund holdings CSV ────────────────────────────────────────────────────────

/** An equity holdings CSV (QYLD-shaped), incl. a cash line and a negative-weight option line. */
export function equityHoldingsCsv(asOf = "07/08/2026"): string {
  return [
    "Global X Nasdaq 100 Covered Call ETF",
    `Fund Holdings Data as of ${asOf}`,
    "% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)",
    // Intentionally NOT weight-ordered, to prove the parser sorts desc.
    '0.71,ASML,ASML HOLDING NV-NY REG SHS,B908F01,1768.65,"33,229.00","58,770,470.85"',
    '0.74,GILD,GILEAD SCIENCES INC,2369174,135.82,"450,716.00","61,216,247.12"',
    '0.01,"",OTHER PAYABLE & RECEIVABLES,"",1.0,"824,459.18","824,459.18"',
    '-0.14,"",NDX US 07/17/26 C30325,"",4060.0,"-2,794.00","-11,343,640.00"',
    '"The information contained herein may not be reproduced, redistributed or used to create any derivative works."',
    "",
  ].join("\n");
}

/** A fixed-income holdings CSV (EMBD-shaped): same 7-column layout, blank constituent tickers. */
export function bondHoldingsCsv(asOf = "07/08/2026"): string {
  return [
    "Global X Emerging Market Bond ETF",
    `Fund Holdings Data as of ${asOf}`,
    "% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)",
    '0.73,"",BRAZIL 7 1/4 01/12/56,BT6M251,1.019849472222222,"1,800,000.00","1,835,729.05"',
    '0.68,"",PANAMA 6.4 02/14/35,BP0XN37,1.072759658823529,"1,700,000.00","1,823,691.42"',
    "",
  ].join("\n");
}

/**
 * A router covering the full holdings flow: the Explore page, each fund's page, and each fund's
 * dated CSV. Unknown URLs throw (a 404), so the driver's fallbacks and skip-on-miss are exercised.
 */
export function fullRouter(
  funds: FakeFund[],
  csvByTicker: Record<string, string>,
  ymd = "20260708",
): (url: string) => string {
  return (url: string): string => {
    if (url === EXPLORE_URL) return exploreHtml(funds);
    for (const [tk, csv] of Object.entries(csvByTicker)) {
      if (url === holdingsCsvUrl(tk, ymd)) return csv;
      if (url === fundPageUrl(tk)) return fundPageHtml(tk, ymd);
    }
    throw new Error(`404 for ${url}`);
  };
}
