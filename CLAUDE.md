# vgi-etf-globalx — agent notes

A VGI (DuckDB) worker exposing Global X US ETF data as two base **tables** — `products` (the
catalog) and `holdings` (hive-partitioned) — plus the listed `holdings_scan` backing the holdings
table. There are NO other callable functions. TypeScript, runs on Bun, built on `@query-farm/vgi`
(the TS SDK). Keyless — no secret type, no auth. Modeled on the sibling `vgi-etf-spdr` worker (the
closest analog: a file-download issuer with CURRENT holdings only, so `holdings` has NO time
travel). The key differences from vgi-etf-spdr: the catalog is scraped from a Next.js RSC payload (not
a JSON API), holdings are CSV (not XLSX, so NO extra dependency), and there is no NAV-history plane.

## Base tables (`products`, `holdings`) — two layers: registry vs listing

Tables are wired via `SchemaDescriptor.tables` (`makeCatalog`'s `tables: [...]`); each
`TableDescriptor` has `function: <scan>` + `arguments: new Arguments([], new Map())` and carries
its docs on `tags`/`comment`/`columnComments`. Two INDEPENDENT layers matter:
- **FunctionRegistry** (`registry.register(scan)`) — the *dispatch* layer. Required for a table to
  be scannable.
- **catalog `schemas[].functions`** — the *listing* layer. Controls what shows as a callable `X()`
  function AND is where the extension discovers a scan's capabilities (e.g. `filter_pushdown`).

`products`: backing `productsScan` is **registered but NOT listed** → exposed only as the table.
`holdings`: backing `holdingsScan` MUST be **listed** (`functions: [...functions, holdingsScan]`,
and `functions` is empty here) — an unlisted backing scan gets no `pushdown_filters` (the extension
can't see its `filter_pushdown` capability), so the `fund_ticker` partition filter never reaches
it (verified locally: unlisted → a full 12k-row scan + post-FILTER instead of a pushed-down
partition scan). Hence a visible `holdings_scan` is unavoidable. Rather than waive VGI311
(parameterless-table-function), `holdings_scan` takes a genuine optional `fund_ticker` argument
(named-only: `holdings_scan(fund_ticker => 'QYLD')`) — a real callable, not a bare zero-arg scan —
so the rule passes with no suppression. The `holdings` TABLE still binds it with no argument and
relies on pushdown; the argument only routes when someone calls the function directly.

## `holdings` — hive-partitioned by `fund_ticker`, CURRENT holdings only (no time travel)

Query `FROM globalx.main.holdings WHERE fund_ticker = 'QYLD'` (fund selector); an **unfiltered scan
streams every fund** (one partition per fund). Mechanics:
- **Hive partitioning + streaming queue.** `holdingsScan` is a `partitionKind:
  "SINGLE_VALUE_PARTITIONS"` generator — `fund_ticker` is the partition key (annotated
  `vgi.partition_column` in `holdingsSchema`). `onInit` reads the pushed `fund_ticker` filter (or,
  absent one, the whole catalog) and `queuePush`es one `{ticker, asOf}` item per fund onto a
  `BoundStorage` queue keyed by the execution id. `process()` pops one fund per tick, fetches its
  holdings CSV, and `out.emit`s a single partition batch tagged with `vgi_partition_values`
  (min==max==ticker). `maxWorkers` workers drain the same queue → work-stealing fan-out. `LIMIT`
  short-circuits the stream.
- **No time travel.** Global X has only one current holdings file per fund. There is deliberately
  NO `supportsTimeTravel` and NO as-of argument; `process()` never reads `p.atValue`. `as_of_date`
  is a real output column populated from the CSV's "Fund Holdings Data as of MM/DD/YYYY" line.
- **404/empty-tolerant.** A fund with no holdings file yields `[]` from `fetchHoldings` (all three
  discovery strategies miss); `process()` skips it and pops the next, so an all-funds scan never
  fails on one missing fund.
- **`filterPushdown: true`** + LISTED → the extension pushes the `fund_ticker` filter into the scan.
- **`fund_ticker` is a SEPARATE column from `ticker`** — `ticker` is the CONSTITUENT's own ticker
  (may carry an exchange suffix like "6104 JP"; blank for cash/derivative lines); `fund_ticker` is
  the fund's ticker, constant per fund. The scan tags every row with the requested fund ticker,
  upper-cased.
- Constraints: `products` advisory PK `[ticker]` (Global X exposes no ISIN/CUSIP); `holdings` has a
  NOT-NULL composite PK `(fund_ticker, name, sedol)` — verified unique across every fund's current
  holdings (a preferred issuer can hold two series under one name/ticker distinguished only by
  SEDOL, and cash/derivative lines carry no SEDOL, so the scan emits `''` (never NULL) for a blank
  name/sedol to keep the key columns non-null). No cross-table FK (identifier columns recur with
  different meanings) — VGI809 does not fire. `vgi-lint.toml` carries NO `ignore` list; the static
  and `--execute --ai` gates are both clean at `fail-on: info` with nothing suppressed.

## Catalog is a Next.js RSC flight payload (NOT a JSON API)

The `/explore` page is server-rendered by Next.js App Router, but the fund table hydrates
client-side (the `<tbody>` cells are `animate-pulse` skeletons). The real data is in the RSC
**flight payload**: a series of `self.__next_f.push([n,"…"])` script strings. The driver:
- `extractFlightText(html)` — matches every `push([n,"…"])`, **concatenates all inner strings
  BEFORE unescaping** (a record can span a chunk boundary), then `JSON.parse('"'+joined+'"')`.
- `flightRecords(text)` — splits into `id:json` lines → `Map<id, rawJson>`.
- `resolveFlight(value, records)` — resolves the reference system: `$id` → another record (parsed
  recursively, bounded depth), `$D…` → the ISO date string, `$undefined` → undefined.
- `parseProducts` — picks records that look like catalog objects (contain `"ETF_TICKER"` +
  `"FUND_DATA"`), resolves each, and flattens `FUND_DATA` (name/nav/net_assets/dates + `anl_perf`
  {year_1/3/5/10, since_inception} + `cum_perf` {month_1/month_3/ytd}) plus the top-level
  THEME/SUB_THEME/GROSS_EXP/NET_EXP/FACT_SHEET into a flat row. ~116 funds.

There is NO `/api/*` fund endpoint (they 404). No headless browser is needed — plain `fetch` with a
browser User-Agent returns the full HTML including the flight payload.

**Units gotcha:** GROSS_EXP/NET_EXP arrive already in percent points (0.6 = 0.6%) — NOT scaled.
Performance figures (anl_perf/cum_perf) arrive as **fractions** (0.243 = 24.3%) and ARE scaled ×100
(`fracToPercent`) so the `return_*_percent` columns hold percent points like the sibling workers.
NET_EXP is often `$undefined` (→ null). `net_assets`/`nav` are plain USD (no scaling).

## Holdings are dated CSVs — three-strategy URL discovery

Per-fund holdings live at
`assets.globalxetfs.com/funds/holdings/{ticker}_full-holdings_YYYYMMDD.csv`. The filename carries
the publication date and there is **no date-less alias** (the bare path 404s). `fetchHoldings`
finds the dated URL cheapest-first:
1. **as-of hint** — the catalog `AS_OF_DATE` (verified to match the file date for all funds) →
   `holdingsCsvUrl(ticker, epochToYmd(asOf))`, one cheap CSV fetch. This is the normal path; the
   holdings scan passes each fund's `asOfDate` from the cached catalog as the hint.
2. **fund-page link** — fetch `https://www.globalxetfs.com/funds/{ticker}/`, extract the
   `..._full-holdings_YYYYMMDD.csv` link via `holdingsLinkFromHtml`.
3. **walk-back** — try `holdingsCsvUrl` for each of the last `HOLDINGS_LOOKBACK_DAYS` calendar days.

The CSV layout is UNIFORM across fund types (equity, commodity/miners, fixed income, preferreds):
`% of Net Assets,Ticker,Name,SEDOL,Market Price ($),Shares Held,Market Value ($)`. Still parsed
**header-driven** (`parseHoldings` finds the "% of Net Assets" header row, maps each column by its
lowercased label) for robustness. Numbers are quoted when they contain thousands separators
(`"450,716.00"`), so `parseCsv` is a small quote-aware CSV state machine and `asNum` strips
`$ , % "`. Data rows run until a row with neither a weight nor a name (the free-text disclaimer
footer). `parseHoldings` sorts by `weight_percent` DESC (NULLS last) so `... LIMIT n` returns the
top holdings. No SheetJS / xlsx dependency (unlike vgi-etf-spdr).

## Architecture (keep this separation)

- **`src/globalx.ts` — the pure driver.** URL builders + flight/CSV parsers, plus thin `fetch*`
  orchestrators and `resolveTicker`, all taking an injected `get(url) => Promise<string>` (text).
  NO network, NO SDK import. This is what the unit tests exercise. All parsing is defensive: a
  missing field/record/column/row degrades to `[]`/`null`/`""`, never a throw. `resolveTicker`
  returns `string | null` (null = not found) rather than throwing, so this module needs no SDK
  import (there is no `functions.ts` resolver wrapper because no callable function takes a `fund`
  arg — the holdings scan resolves fund_ticker straight from the catalog in `onInit`).
- **`src/client.ts` — the only network module.** `makeGlobalxClient()` returns `{ get }` (and
  `makeGlobalxGet()` the bare `get`). A SINGLE text transport — both planes (Explore HTML, holdings
  CSV) are text, so there is no JSON or binary `getBytes` (unlike vgi-etf-spdr). `get` memoizes the
  `/explore` page for 24 h; fund pages and CSVs are never cached. Its one job beyond `fetch` is the
  browser-like User-Agent Global X requires. Verified live, not in the unit suite.
- **`src/schema.ts` — typed Arrow schemas + batch builders.** Real typed columns
  (`Utf8`/`Float64`/`DateDay`), not JSON. Every calendar date is a real Arrow **DATE** (`DateDay`
  → DuckDB `DATE`, no timezone; a DATE cell is a JS `Date` at UTC midnight via `dateOrNull`). NOTE:
  dates are DATE, not TIMESTAMP (casting a UTC-midnight TIMESTAMPTZ `::DATE` shifts the day in
  non-UTC sessions). Percent columns carry a `_percent` suffix and hold **percent points**.
- **`src/functions.ts`** — two `defineTableFunction`s: `makeProductsScan` (unlisted products
  backing scan) and `makeHoldingsScan` (`holdings_scan`, LISTED, filterPushdown, SINGLE_VALUE
  partitions, queue/BoundStorage streaming). Each `make*` takes the whole `GlobalxClient`.
- **`src/catalog.ts` / `src/worker.ts`** — catalog descriptor (no `secretTypes`) and the entry
  that wires the real client into the scans. `makeCatalog(functions, productsScan, holdingsScan)`
  keeps the sibling signature; `functions` is `[]` (no callable functions).

## Global X endpoint facts (why the design is what it is)

Two keyless planes, both plain text needing only the browser User-Agent:

1. **Explore page** — `GET https://www.globalxetfs.com/explore`. ~1.2 MB HTML; fund data in the
   `self.__next_f.push` flight payload (see above). Backs `products` and the fund universe in the
   holdings scan.
2. **holdings CSV** — `GET https://assets.globalxetfs.com/funds/holdings/{ticker}_full-holdings_YYYYMMDD.csv`
   (lower-case ticker; dated filename, no alias). Fund pages
   `https://www.globalxetfs.com/funds/{ticker}/` carry the dated link (fallback strategy 2).

There is NO date function argument anywhere (holdings is current-only; products takes no args), so
the driver has no `dateArgToEpoch`; `parseDate` handles ISO/ISO-datetime (flight) and MM/DD/YYYY
(CSV "as of") internally, returning epoch seconds for the DateDay path.

## Commands

```bash
bun install
bun test            # 32 tests: SDK-free driver + Arrow batch builders + live HTTP-transport E2E
bun run typecheck   # own-source only; scripts/typecheck.sh filters node_modules errors
./run_tests.sh      # haybarn SQLLogic E2E: worker under real DuckDB + community vgi ext
```

`run_tests.sh` sets `VGI_TEST_WORKER=bin/vgi-etf-globalx-worker` + `VGI_WORKER_CATALOG_NAME=globalx`
and runs `test/sql/*.test` (DESCRIBE-based schema asserts + a few live-invariant asserts that hit
Global X). CI runs this, the reusable `ts-ci.yml`, and a `vgi-lint` gate at `--fail-on info`
(currently 100/100).

Typecheck must be a `bash scripts/typecheck.sh` file (not an inline package.json pipeline) —
`bun run` uses Bun's shell, which mishandles the `grep -v node_modules` filter. `typescript`
is on `^7.0.2` (the native compiler; own-source typecheck is clean). The `scripts/typecheck.sh`
filter drops any external SDK `.ts`-source errors regardless of the TS major.

## Gotchas / conventions

- Emit `Date` (rich repr) for DATE columns via `batchFromColumns`; date fields go through
  `parseDate` (→ epoch seconds) then `dateOrNull`.
- `noUncheckedIndexedAccess` is on: guard matrix/array cell reads (the parsers null-check before
  use, e.g. `at(col)` returning `undefined` for a missing column) so cells don't type as `undefined`.
- vgi-lint rules to keep satisfied: catalog/schema descriptions must NOT enumerate the worker's own
  functions (VGI173); numeric column comments should state units (VGI131 — e.g. "per share in USD",
  "percent points"); argument docs must NOT restate the data type (VGI313); every function needs an
  agent test task (VGI520 — products/holdings/holdings_scan are covered in `catalog.ts`
  `vgi.agent_test_tasks`).
- Don't add a secret type; this worker is keyless by design.
- Keep the `holdings` current-only contract: do NOT add `supportsTimeTravel` or an as-of arg.
- Global X exposes NO ISIN/CUSIP in the catalog, so the products PK is `[ticker]`.

## DuckDB (manual)

```sql
LOAD vgi;
ATTACH 'globalx' AS globalx (TYPE vgi, LOCATION '/path/to/vgi-etf-globalx/bin/vgi-etf-globalx-worker');
SELECT ticker, net_assets FROM globalx.products ORDER BY net_assets DESC LIMIT 10;
SELECT name, ticker, weight_percent FROM globalx.holdings WHERE fund_ticker = 'QYLD' ORDER BY weight_percent DESC LIMIT 10;
```
