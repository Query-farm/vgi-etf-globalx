// The Global X (Mirae Asset) driver — pure logic, no @query-farm SDK import. Every fetch* takes
// an injected `get(url) => Promise<string>` (text: HTML or CSV), so the archetype-proof tests
// drive it against an in-process fake and the worker wires the real HTTP client (client.ts).
// This module MUST NOT import from @query-farm/* — the unit tests import it without the SDK.
//
// Two KEYLESS Global X data planes back the read paths, BOTH plain text over a browser UA:
//
//   /explore                                     → products (a server-rendered Next.js page whose
//                                                   fund data lives in the RSC "flight" payload)
//   assets.globalxetfs.com/.../{tk}_full-holdings_YYYYMMDD.csv → holdings (a per-fund CSV)
//
// PRODUCTS come from the Next.js App-Router flight payload embedded in the /explore HTML as a
// series of `self.__next_f.push([1,"…"])` string chunks. Concatenated and JSON-unescaped, the
// payload is a set of newline-delimited `id:json` records with a reference system ($id → another
// record, $D… → a date, $undefined). `parseProducts` extracts the fund records and resolves the
// references into flat rows.
//
// HOLDINGS come from a per-fund CSV on the CDN whose filename carries the publication date
// (there is NO date-less alias — the bare path 404s). `fetchHoldings` finds the dated URL three
// ways, cheapest first: (1) a caller-supplied as-of hint (the catalog's AS_OF_DATE, which matches
// the file date), (2) the link embedded on the fund's page, (3) a walk back over recent days.
// Global X publishes CURRENT holdings only, so there is no as-of/time-travel coordinate.
//
// Every parser is defensive: a missing field / column / row degrades to an empty result or a
// null cell rather than throwing. `resolveTicker` returns null (not a throw) on an unknown
// ticker so the caller (functions.ts) can raise a typed SDK error while this module stays
// SDK-free.
//
// DATES: the driver returns dates as epoch SECONDS at UTC midnight (number | null). The Arrow
// mapping to a real DATE column lives in schema.ts (keeping this module type/SDK-free).

export const GLOBALX_HOST = "https://www.globalxetfs.com";
export const ASSETS_HOST = "https://assets.globalxetfs.com";

/** The Explore page: the server-rendered catalog of every Global X US ETF. */
export const EXPLORE_URL = `${GLOBALX_HOST}/explore`;

/** The public fund page for a fund (ticker lower-cased into the path); carries the holdings link. */
export function fundPageUrl(ticker: string): string {
  return `${GLOBALX_HOST}/funds/${ticker.trim().toLowerCase()}/`;
}

/** The dated full-holdings CSV URL for a fund (ticker lower-cased; ymd = YYYYMMDD). */
export function holdingsCsvUrl(ticker: string, ymd: string): string {
  return `${ASSETS_HOST}/funds/holdings/${ticker.trim().toLowerCase()}_full-holdings_${ymd}.csv`;
}

/** How many days back `fetchHoldings` walks looking for a dated CSV as a last resort. */
export const HOLDINGS_LOOKBACK_DAYS = 8;

// ── shared value coercion ───────────────────────────────────────────────────────

/** True for "no data": null/undefined, "", or all-whitespace. */
function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

const asStr = (v: unknown): string | null => (isBlank(v) ? null : String(v).trim());

/** A numeric value, stripping $, %, commas and surrounding quotes/space. Null if not finite. */
const asNum = (v: unknown): number | null => {
  if (isBlank(v)) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[$,%"\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// ── date parsing ────────────────────────────────────────────────────────────────

/** Build epoch SECONDS at UTC midnight from y/m/d, validating the parts round-trip. Null if bad. */
function ymdToEpoch(y: number, mo0: number, d: number): number | null {
  const ms = Date.UTC(y, mo0, d);
  if (Number.isNaN(ms)) return null;
  const dt = new Date(ms);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo0 || dt.getUTCDate() !== d) return null;
  return Math.floor(ms / 1000);
}

/**
 * Parse the date shapes Global X uses → epoch SECONDS at UTC midnight (or null):
 *   ISO / ISO-datetime  "2026-07-08" or "2026-07-08T00:00:00.000Z"  (flight payload)
 *   US slash            "07/08/2026"  (the holdings CSV "as of" line, MM/DD/YYYY)
 */
export function parseDate(v: unknown): number | null {
  if (isBlank(v)) return null;
  if (v instanceof Date) return ymdToEpoch(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return ymdToEpoch(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return ymdToEpoch(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return null;
}

/** Format epoch SECONDS (or a Date) as a YYYYMMDD string at UTC. */
export function epochToYmd(sec: number | Date): string {
  const d = sec instanceof Date ? sec : new Date(sec * 1000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${mo}${day}`;
}

// ── Next.js flight payload extraction ────────────────────────────────────────────

/**
 * Concatenate the RSC flight string chunks from the `self.__next_f.push([n,"…"])` calls in a
 * Next.js page and JSON-unescape them into the raw flight text. A record can span a chunk
 * boundary, so all chunk strings are joined BEFORE unescaping. Returns "" when none are present.
 */
export function extractFlightText(html: string): string {
  const re = /self\.__next_f\.push\(\[\d+,"((?:[^"\\]|\\.)*)"\]\)/g;
  const chunks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) chunks.push(m[1]!);
  if (chunks.length === 0) return "";
  try {
    return JSON.parse(`"${chunks.join("")}"`) as string;
  } catch {
    return "";
  }
}

/** Map each flight record id → its raw (unparsed) JSON text, from `id:payload` lines. */
export function flightRecords(flightText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of flightText.split("\n")) {
    const m = /^([0-9a-zA-Z]+):(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * Resolve a flight value: strings starting with `$` are references (`$id` → another record),
 * dates (`$D…` → the ISO string), or `$undefined`; objects/arrays resolve recursively. Bounded
 * depth so a malformed cyclic reference can't loop forever.
 */
function resolveFlight(value: unknown, records: Map<string, string>, depth = 0): unknown {
  if (depth > 12) return value;
  if (typeof value === "string") {
    if (value === "$undefined") return undefined;
    if (value.startsWith("$D")) return value.slice(2); // an ISO date string
    if (value.startsWith("$")) {
      const raw = records.get(value.slice(1));
      if (raw == null) return undefined;
      try {
        return resolveFlight(JSON.parse(raw), records, depth + 1);
      } catch {
        return undefined;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveFlight(v, records, depth + 1));
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) o[k] = resolveFlight(v, records, depth + 1);
    return o;
  }
  return value;
}

// ── products (the Explore-page catalog) ─────────────────────────────────────────

export interface ProductRow {
  ticker: string | null;
  fundName: string | null;
  /** Top-level theme (asset-class-like): Equity, Fixed Income, Alternatives & Specialty Equity. */
  theme: string | null;
  /** Sub-theme / category: Income, Thematic, Commodities, International, Core, Real Assets, … */
  subTheme: string | null;
  inceptionDate: number | null;
  asOfDate: number | null;
  performanceAsOf: number | null;
  nav: number | null;
  netAssets: number | null;
  grossExpenseRatioPercent: number | null;
  netExpenseRatioPercent: number | null;
  return1mPercent: number | null;
  return3mPercent: number | null;
  ytdReturnPercent: number | null;
  return1yPercent: number | null;
  return3yPercent: number | null;
  return5yPercent: number | null;
  return10yPercent: number | null;
  returnSinceInceptionPercent: number | null;
  factSheetUrl: string | null;
}

/** A fraction (0.243) → percent points (24.3), or null. Global X reports returns as fractions. */
function fracToPercent(v: unknown): number | null {
  const n = asNum(v);
  return n == null ? null : n * 100;
}

/**
 * Map the resolved flight catalog records to product rows. `ticker`, when non-empty, narrows to
 * that one fund (case-insensitive). Expense ratios arrive already in percent points; performance
 * figures arrive as fractions and are scaled to percent points to match the `_percent` columns.
 */
export function parseProducts(html: string, ticker = ""): ProductRow[] {
  const records = flightRecords(extractFlightText(html));
  if (records.size === 0) return [];
  const wantTicker = ticker.trim().toUpperCase();
  const rows: ProductRow[] = [];
  const seen = new Set<string>();
  for (const raw of records.values()) {
    if (!raw.startsWith("{") || !raw.includes('"ETF_TICKER"') || !raw.includes('"FUND_DATA"')) {
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = resolveFlight(JSON.parse(raw), records) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tk = asStr(obj.ETF_TICKER);
    if (!tk || seen.has(tk.toUpperCase())) continue;
    if (wantTicker && tk.toUpperCase() !== wantTicker) continue;
    seen.add(tk.toUpperCase());
    const fd = (obj.FUND_DATA ?? {}) as Record<string, unknown>;
    const anl = (fd.anl_perf ?? {}) as Record<string, unknown>;
    const cum = (fd.cum_perf ?? {}) as Record<string, unknown>;
    rows.push({
      ticker: tk,
      fundName: asStr(fd.etf_name),
      theme: asStr(obj.THEME),
      subTheme: asStr(obj.SUB_THEME),
      inceptionDate: parseDate(fd.inception_date),
      asOfDate: parseDate(obj.AS_OF_DATE),
      performanceAsOf: parseDate(fd.month_end_date),
      nav: asNum(fd.nav),
      netAssets: asNum(fd.net_assets),
      grossExpenseRatioPercent: asNum(obj.GROSS_EXP),
      netExpenseRatioPercent: asNum(obj.NET_EXP),
      return1mPercent: fracToPercent(cum.month_1),
      return3mPercent: fracToPercent(cum.month_3),
      ytdReturnPercent: fracToPercent(cum.ytd),
      return1yPercent: fracToPercent(anl.year_1),
      return3yPercent: fracToPercent(anl.year_3),
      return5yPercent: fracToPercent(anl.year_5),
      return10yPercent: fracToPercent(anl.year_10),
      returnSinceInceptionPercent: fracToPercent(anl.since_inception),
      factSheetUrl: asStr(obj.FACT_SHEET),
    });
  }
  return rows;
}

export async function fetchProducts(
  get: (url: string) => Promise<unknown>,
  ticker = "",
): Promise<ProductRow[]> {
  return parseProducts(String(await get(EXPLORE_URL)), ticker);
}

// ── ticker resolution (validate + canonicalize against the catalog) ─────────────

/**
 * Resolve a `fund` argument to a fund's canonical ticker by matching the catalog
 * (case-insensitive). Returns null when the ticker isn't in the Global X lineup (the caller
 * raises a typed ArgumentValidationError — this module stays SDK-free). One Explore fetch.
 */
export async function resolveTicker(
  get: (url: string) => Promise<unknown>,
  fund: string,
): Promise<string | null> {
  const wanted = fund.trim().toUpperCase();
  if (!wanted) return null;
  const products = parseProducts(String(await get(EXPLORE_URL)));
  const hit = products.find((p) => (p.ticker ?? "").toUpperCase() === wanted);
  return hit ? hit.ticker : null;
}

// ── CSV decoding ─────────────────────────────────────────────────────────────────

/**
 * Parse CSV text into a matrix of string cells. Handles double-quoted fields (Global X quotes
 * numbers that contain thousands separators, e.g. `"450,716.00"`), doubled quotes as an escape,
 * and CRLF or LF line endings. A blank trailing line yields no row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    started = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ",") pushField();
    else if (ch === "\n") pushRow();
    else if (ch === "\r") {
      /* swallow; the following \n ends the row */
    } else field += ch;
  }
  if (started || field !== "" || row.length > 0) pushRow();
  return rows;
}

// ── holdings (the per-fund CSV) ──────────────────────────────────────────────────

export interface HoldingRow {
  /** The fund's ticker — the partition key (constant per fund; distinct from the constituent `ticker`). */
  fundTicker: string | null;
  asOfDate: number | null;
  weightPercent: number | null;
  /** Constituent ticker (may carry an exchange suffix like "6104 JP"; blank for cash/derivative lines). */
  ticker: string | null;
  name: string | null;
  sedol: string | null;
  marketPrice: number | null;
  sharesHeld: number | null;
  marketValue: number | null;
}

/** Map a lowercased CSV header label → column index. */
function headerColumns(header: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let c = 0; c < header.length; c++) {
    const name = (header[c] ?? "").trim().toLowerCase();
    if (name) map.set(name, c);
  }
  return map;
}

/**
 * Parse a full-holdings CSV into holding rows, sorted by weight desc (NULLS last). The CSV's first
 * two lines are the fund name and a "Fund Holdings Data as of MM/DD/YYYY" line; line three is the
 * column header. Header-driven: each constituent column is mapped by its label, so a reordered or
 * augmented header still binds. Data runs until the disclaimer footer (a single wide free-text row).
 */
export function parseHoldings(csvText: string, fundTicker: string | null): HoldingRow[] {
  const matrix = parseCsv(csvText);
  // Find the header row: the first row whose first cell is the "% of Net Assets" label.
  let hdr = -1;
  for (let i = 0; i < matrix.length; i++) {
    if ((matrix[i]?.[0] ?? "").trim().toLowerCase().startsWith("% of net assets")) {
      hdr = i;
      break;
    }
  }
  if (hdr < 0) return [];
  const cols = headerColumns(matrix[hdr]!);
  const c = (label: string) => cols.get(label);
  // As-of date from the "… as of MM/DD/YYYY" line above the header.
  let asOf: number | null = null;
  for (let i = 0; i < hdr; i++) {
    const cell = matrix[i]?.[0] ?? "";
    const m = /as of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(cell);
    if (m) {
      asOf = parseDate(m[1]);
      break;
    }
  }
  const weightCol = c("% of net assets");
  const nameCol = c("name");
  const rows: HoldingRow[] = [];
  for (let i = hdr + 1; i < matrix.length; i++) {
    const r = matrix[i] ?? [];
    // A data row has a weight and/or a name; the footer disclaimer is a single free-text cell.
    const weight = asNum(weightCol == null ? undefined : r[weightCol]);
    const name = asStr(nameCol == null ? undefined : r[nameCol]);
    if (weight == null && name == null) continue;
    const at = (col: number | undefined) => (col == null ? undefined : r[col]);
    rows.push({
      fundTicker,
      asOfDate: asOf,
      weightPercent: weight,
      ticker: asStr(at(c("ticker"))),
      name,
      sedol: asStr(at(c("sedol"))),
      marketPrice: asNum(at(c("market price ($)")) ?? at(c("market price"))),
      sharesHeld: asNum(at(c("shares held"))),
      marketValue: asNum(at(c("market value ($)")) ?? at(c("market value"))),
    });
  }
  rows.sort((a, b) => (b.weightPercent ?? -Infinity) - (a.weightPercent ?? -Infinity));
  return rows;
}

/** Extract a fund's dated full-holdings CSV URL from its fund-page HTML, or null. */
export function holdingsLinkFromHtml(html: string, ticker: string): string | null {
  const tk = ticker.trim().toLowerCase();
  const re = new RegExp(
    `https://assets\\.globalxetfs\\.com/funds/holdings/${tk}_full-holdings_\\d{8}\\.csv`,
    "g",
  );
  const hits = html.match(re);
  return hits && hits.length > 0 ? hits[hits.length - 1]! : null;
}

async function tryCsv(
  get: (url: string) => Promise<unknown>,
  ticker: string,
  ymd: string,
  fundTicker: string,
): Promise<HoldingRow[] | null> {
  try {
    return parseHoldings(String(await get(holdingsCsvUrl(ticker, ymd))), fundTicker);
  } catch {
    return null;
  }
}

export interface FetchHoldingsOptions {
  /** The catalog's AS_OF_DATE (epoch seconds) — used to build the CSV URL directly, cheapest path. */
  asOfHint?: number | null;
  /** "Today" for the walk-back fallback (injectable for tests). Defaults to the real clock. */
  today?: Date;
  /** How many days back to walk in the fallback (default HOLDINGS_LOOKBACK_DAYS). */
  lookbackDays?: number;
}

/**
 * Current holdings for one fund (Global X publishes current holdings only, so there is no
 * as-of/time-travel coordinate). Finds the dated CSV URL cheapest-first:
 *   1. the as-of hint (the catalog AS_OF_DATE, which matches the file date) — one CSV fetch,
 *   2. the link embedded on the fund's page,
 *   3. a walk back over recent calendar days.
 * Returns [] for a fund with no published holdings file.
 */
export async function fetchHoldings(
  get: (url: string) => Promise<unknown>,
  fundTicker: string,
  opts: FetchHoldingsOptions = {},
): Promise<HoldingRow[]> {
  const tk = fundTicker.trim();
  const up = tk.toUpperCase();

  // 1. Direct URL from the as-of hint.
  if (opts.asOfHint != null) {
    const rows = await tryCsv(get, tk, epochToYmd(opts.asOfHint), up);
    if (rows && rows.length > 0) return rows;
  }

  // 2. Link embedded on the fund page.
  try {
    const link = holdingsLinkFromHtml(String(await get(fundPageUrl(tk))), tk);
    if (link) {
      const rows = parseHoldings(String(await get(link)), up);
      if (rows.length > 0) return rows;
    }
  } catch {
    /* fall through to the walk-back */
  }

  // 3. Walk back over recent days.
  const start = opts.today ?? new Date();
  const lookback = opts.lookbackDays ?? HOLDINGS_LOOKBACK_DAYS;
  for (let i = 0; i < lookback; i++) {
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - i));
    const rows = await tryCsv(get, tk, epochToYmd(d), up);
    if (rows && rows.length > 0) return rows;
  }
  return [];
}
