# vgi-etf-globalx

A [VGI](https://query.farm) worker that exposes **Global X** US ETF data as DuckDB tables — the
full ETF catalog and a partitioned holdings table.

| Object | What it returns | Global X source |
| --- | --- | --- |
| `globalx.products` (table) | Every US ETF with key facts, one row per fund | the `/explore` page |
| `globalx.holdings` (table) | Detailed current holdings, partitioned by fund_ticker | per-fund `_full-holdings_YYYYMMDD.csv` |

Everything rides Global X's public website — there is no secret to create and no login. Funds are
identified by their exchange **ticker** (e.g. `QYLD`); the holdings table resolves the fund
universe via one `/explore` lookup.

Two conventions to know:
- **Dates are real `DATE` columns** (no timezone) — compare them directly, e.g.
  `WHERE as_of_date = DATE '2026-07-08'`.
- **Percent columns carry a `_percent` suffix and hold percent points**:
  `gross_expense_ratio_percent` = 0.60 means 0.60%; `weight_percent` = 0.74 means 0.74% (weights
  sum to ~100). Returns are reported by Global X as fractions and normalized to percent points here.

> **Current holdings only.** Global X publishes a single, current daily-holdings CSV per fund, so
> `holdings` has **no time travel / as-of argument** — `as_of_date` reflects the published file's
> own date. (This matches the sibling `vgi-etf-spdr` worker and differs from `vgi-etf-ishares`.)

> **Status:** initial build. Unit tests (SDK-free driver + Arrow batch builders), own-source
> typecheck, a live HTTP-transport smoke test, the haybarn SQLLogic E2E suite against a real
> DuckDB + the community `vgi` extension, and a `vgi-lint` metadata gate at 100/100 all pass.

## Quick start

Every [GitHub release](https://github.com/Query-farm/vgi-etf-globalx/releases) ships a prebuilt worker binary. The `vgi` extension downloads the one for your platform, checks its SHA-256 and caches it, so there is nothing to install besides DuckDB:

```sql
INSTALL vgi FROM community;
LOAD vgi;

ATTACH 'globalx' AS globalx (TYPE vgi, LOCATION 'github-auto://Query-farm/vgi-etf-globalx@v0.4.0');

-- The largest Global X ETFs by net assets
SELECT ticker, fund_name, net_assets FROM globalx.main.products ORDER BY net_assets DESC LIMIT 5;

-- The top holdings of the Global X Nasdaq 100 Covered Call ETF
SELECT name, ticker, weight_percent FROM globalx.main.holdings WHERE fund_ticker = 'QYLD' ORDER BY weight_percent DESC LIMIT 5;
```

Prebuilt binaries cover macOS (Apple silicon), Linux (x86-64 and arm64). `github-auto://` needs an explicit release tag; change `@v0.4.0` to move to a newer release.

### Other ways to run it

- **Docker** (the image bundles the worker; needs a container runtime):

  ```sql
  ATTACH 'globalx' AS globalx (TYPE vgi, LOCATION 'docker://ghcr.io/query-farm/vgi-etf-globalx:0.4.0');
  ```

- **Manual download.** Download the archive for your platform from the [releases page](https://github.com/Query-farm/vgi-etf-globalx/releases), verify it against its `.sha256` file (a cosign `.cosign.bundle` is published alongside), unpack it, and set `LOCATION` to the path of the extracted worker executable.

- **HTTP server.** Run the image's HTTP transport yourself and attach it by URL:

  ```bash
  docker run --rm -p 8000:8000 ghcr.io/query-farm/vgi-etf-globalx:0.4.0   # serves /health + the VGI RPC on :8000
  ```

  ```sql
  ATTACH 'globalx' AS globalx (TYPE vgi, LOCATION 'http://localhost:8000');
  ```

### Build from source

For development or the latest `main`, run the worker on [Bun](https://bun.sh):

```bash
bun install
```

```sql
LOAD vgi;
ATTACH 'globalx' AS globalx (TYPE vgi, LOCATION '/path/to/vgi-etf-globalx/bin/vgi-etf-globalx-worker');
```

`bin/vgi-etf-globalx-worker` is a small wrapper that launches `src/worker.ts` under Bun.

Tests, typecheck and the E2E suite are described under [Development](#development).

## Usage

### products — the fund catalog (a base table)

`products` is a plain **table** — no arguments, no parentheses. It returns the whole ETF lineup;
filter with `WHERE`.

```sql
-- Ten largest Global X ETFs by net assets:
SELECT ticker, fund_name, net_assets, gross_expense_ratio_percent
FROM globalx.products
ORDER BY net_assets DESC
LIMIT 10;

-- Cheapest funds by gross expense ratio:
SELECT ticker, fund_name, gross_expense_ratio_percent
FROM globalx.products
ORDER BY gross_expense_ratio_percent
LIMIT 10;

-- Look up one fund by ticker:
SELECT ticker, fund_name, gross_expense_ratio_percent
FROM globalx.products
WHERE ticker = 'QYLD';
```

Filter on `ticker`, `theme` (`'Equity'`, `'Fixed Income'`, `'Alternatives & Specialty Equity'`),
`sub_theme` (`'Income'`, `'Thematic'`, `'Commodities'`, `'International'`, `'Core'`, `'Real
Assets'`, `'Structured'`, `'Digital Assets'`), etc. Columns include `ticker`, `fund_name`,
`theme`, `sub_theme`, `inception_date` (DATE), `nav`, `net_assets`, `gross_expense_ratio_percent`,
`net_expense_ratio_percent`, cumulative / annualized return columns (`return_1m_percent`,
`return_3m_percent`, `ytd_return_percent`, `return_1y/3y/5y/10y_percent`,
`return_since_inception_percent`), and `fact_sheet_url`. All `*_percent` columns are in percent
points. `net_assets` and `nav` are in USD. Since Global X's October 2026 site redesign the Explore
page no longer publishes NAV or the 1m/3m/YTD/3y/5y/10y/since-inception returns, so those columns
are NULL; `return_1y_percent` is the 1-year return at market price.

### holdings — a hive-partitioned table

`holdings` is a **table hive-partitioned by `fund_ticker`** (the fund's ticker). Filter
`fund_ticker` to pick funds, or scan without a filter to stream **every** fund's holdings (one
partition per fund — ~116 funds, so prefer a filter).

```sql
-- Top 10 current holdings of QYLD (already weight-ordered):
SELECT name, ticker, weight_percent, market_value
FROM globalx.holdings
WHERE fund_ticker = 'QYLD'
ORDER BY weight_percent DESC
LIMIT 10;

-- Several funds at once (partition fan-out):
SELECT fund_ticker, name, weight_percent
FROM globalx.holdings
WHERE fund_ticker IN ('QYLD', 'COPX');
```

`fund_ticker` is the **fund's** ticker and the hive partition key — distinct from the `ticker`
column (each row's own constituent ticker; NULL for cash/derivative lines). Columns are the same
across fund types: `weight_percent`, `ticker`, `name`, `sedol`, `market_price`, `shares_held`,
`market_value`. Rows come back **weight-descending**. `as_of_date` (DATE) is the published file's
date — Global X publishes **current holdings only**, so there is no historical time travel. Join
`holdings.fund_ticker` to `products.ticker` for fund-level facts:

```sql
-- Which Global X funds hold the most NVIDIA (in dollars), with each fund's name and sub-theme.
-- No fund_ticker filter, so this scans every fund's holdings (a few seconds).
SELECT h.fund_ticker, p.fund_name, p.sub_theme, h.weight_percent, h.market_value
FROM globalx.holdings h
JOIN globalx.products p ON p.ticker = h.fund_ticker
WHERE h.ticker = 'NVDA'
ORDER BY h.market_value DESC
LIMIT 10;
```

> A backing `holdings_scan(fund_ticker => …)` table function is also exposed (it's what the table
> scans, and it's what lets DuckDB push the `fund_ticker` filter). Call it directly for one fund —
> `SELECT * FROM globalx.main.holdings_scan(fund_ticker => 'QYLD')` — or omit the argument to stream
> every fund; either way, prefer the `holdings` table for normal queries.

## Development

```bash
bun install
bun test            # unit tests (SDK-free driver + Arrow batch builders + live HTTP transport)
bun run typecheck   # own-source typecheck (see scripts/typecheck.sh)
./run_tests.sh      # haybarn SQLLogic E2E under a real DuckDB + the community vgi extension
```

The E2E suite needs the haybarn runner and the vgi extension, once:

```bash
uv tool install --prerelease allow 'haybarn-unittest>=2.0.0rc11,<2.1'
echo "INSTALL vgi FROM community;" | uvx --prerelease allow --from 'haybarn-cli>=2.0.0rc11,<2.1' haybarn-cli
```

Metadata quality is graded by [`vgi-lint`](https://github.com/Query-farm/vgi-lint-check); CI runs
it as a gate at 100/100. Locally:

```bash
uvx --prerelease allow --from vgi-lint-check vgi-lint bin/vgi-etf-globalx-worker --fail-on info
```

The pure request/response logic lives in `src/globalx.ts` and is fully unit-tested against an
in-process fake (`test/fake-globalx.ts`) — no network. The single module that touches the network
is `src/client.ts` (it sets the browser-like User-Agent Global X requires); it is verified live
rather than in the unit suite.

## Data format: the `/explore` scrape & dated CSVs

Global X's site is a **Next.js App-Router** app. The `/explore` page renders a fund table, but the
table cells hydrate client-side; the actual catalog data ships in the page's **RSC "flight"
payload** — a set of `self.__next_f.push([n,"…"])` string chunks that, once concatenated and
JSON-unescaped, decode to newline-delimited `id:json` records with a reference system (`$id` →
another record, `$D…` → a date, `$undefined`). `src/globalx.ts` extracts and resolves that payload
into product rows — no headless browser is needed (plain `fetch` with a browser User-Agent).

Holdings are per-fund **CSV** files on `assets.globalxetfs.com`, whose filename carries the
publication date (`{ticker}_full-holdings_YYYYMMDD.csv`); there is **no date-less alias** (the bare
path 404s). The worker finds the dated URL cheapest-first: (1) the catalog's `AS_OF_DATE` (which
matches the file date), (2) the link embedded on the fund's page, (3) a walk back over recent days.
The CSV is parsed header-driven (each column mapped by its label), so a reordered or augmented
header still binds. No extra dependency is needed — CSV is parsed in the driver.

## Layout

```
src/globalx.ts    Pure driver: URL builders + flight/CSV parsers + fetch orchestrators (no network, no SDK)
src/client.ts     Real fetch client (browser User-Agent; keyless): a single text get (HTML + CSV)
src/schema.ts     Typed Arrow output schemas + row→batch builders
src/functions.ts  The products/holdings backing scans
src/catalog.ts    The `globalx` catalog descriptor (no secret type)
src/worker.ts     Worker entry: wires the real client into the functions
bin/…-worker      Launch wrapper (bun run src/worker.ts) for DuckDB ATTACH
```

## Data source & terms

Data comes from Global X's public website (the `/explore` catalog page and the per-fund holdings
CSVs). It is provided for personal, informational use; consult Global X's terms before any
redistribution or commercial use. This worker is not affiliated with or endorsed by Global X
Management Company LLC / Mirae Asset.

## License

MIT — Copyright 2026 Query Farm LLC · https://query.farm
