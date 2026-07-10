// The `globalx` catalog descriptor + its metadata tags (the vgi.* discovery/doc channels
// vgi-lint grades). Global X's public Explore / holdings endpoints are KEYLESS, so there is
// NO secret type here.
//
// Tag shapes follow vgi-lint's TAGS.md: JSON-valued tags (keywords/categories/
// executable_examples/agent_test_tasks) are JSON strings; all example SQL is
// catalog-qualified (globalx.main.<obj>) so it binds/runs when the catalog is attached.

import type { CatalogDescriptor, VgiFunction } from "@query-farm/vgi";
import { Arguments } from "@query-farm/vgi";
import { productsSchema, holdingsSchema, resultColumnsSchema } from "./schema.js";

const REPO = "https://github.com/Query-farm/vgi-etf-globalx";
const ISSUES = `${REPO}/issues`;

/** Per-column comments for the products table (surface as Arrow field metadata). */
const PRODUCTS_COLUMN_COMMENTS: Record<string, string> = {
  ticker: "Exchange ticker (e.g. QYLD).",
  fund_name: "Full fund name as marketed, e.g. 'Nasdaq 100® Covered Call ETF'.",
  theme: "Top-level theme (Equity, Fixed Income, Alternatives & Specialty Equity).",
  sub_theme: "Sub-theme / category (Income, Thematic, Commodities, International, Core, Real Assets, Structured, Digital Assets).",
  inception_date: "Fund inception date.",
  as_of_date: "As-of date for the pricing fields (nav, net_assets).",
  performance_as_of: "Month-end as-of date for the return columns.",
  nav: "Net asset value per share, in USD.",
  net_assets: "Total net assets (fund AUM), in USD.",
  gross_expense_ratio_percent: "Gross expense ratio, percent points (0.60 = 0.60%).",
  net_expense_ratio_percent: "Net expense ratio after fee waivers, percent points (null when equal to gross).",
  return_1m_percent: "1-month cumulative return, percent points.",
  return_3m_percent: "3-month cumulative return, percent points.",
  ytd_return_percent: "Year-to-date cumulative return, percent points.",
  return_1y_percent: "Annualized 1-year return, percent points.",
  return_3y_percent: "Annualized 3-year return, percent points.",
  return_5y_percent: "Annualized 5-year return, percent points.",
  return_10y_percent: "Annualized 10-year return, percent points.",
  return_since_inception_percent: "Annualized since-inception return, percent points.",
  fact_sheet_url: "URL of the fund's PDF fact sheet.",
};

/** Table-level metadata for the products base table (the vgi.* doc/discovery channels). */
const PRODUCTS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "catalog",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "fund catalog",
    "product list",
    "expense ratio",
    "net assets",
    "theme",
    "ticker",
  ]),
  "vgi.doc_llm":
    "The Global X US ETF catalog as a plain table (query it directly, no arguments): one row per " +
    "ETF with ticker, name, theme/sub-theme, net assets, NAV, gross/net expense ratio, and " +
    "cumulative/annualized returns. Narrow it with a WHERE clause on ticker, theme, sub_theme, " +
    "and so on. Percent columns hold percent points (0.60 means 0.60%). Start here to find a " +
    "fund's ticker for the holdings table.",
  "vgi.doc_md":
    "## products\n\n" +
    "The Global X US ETF catalog as a base table — one row per fund. It takes no arguments; " +
    "query it directly and filter with a WHERE clause (e.g. `WHERE theme = 'Fixed Income' ORDER " +
    "BY net_assets DESC`; see the example queries). Percent columns (`*_percent`) are in " +
    "**percent points** (a gross expense ratio of 0.60 means 0.60%). The ticker column is the " +
    "key for the holdings table.",
  "vgi.example_queries": JSON.stringify([
    { description: "Ten largest Global X ETFs by net assets", sql: "SELECT ticker, fund_name, net_assets FROM globalx.main.products ORDER BY net_assets DESC LIMIT 10" },
    { description: "Cheapest funds by gross expense ratio", sql: "SELECT ticker, fund_name, gross_expense_ratio_percent FROM globalx.main.products ORDER BY gross_expense_ratio_percent LIMIT 10" },
    { description: "Look up a single fund by ticker", sql: "SELECT ticker, fund_name, gross_expense_ratio_percent FROM globalx.main.products WHERE ticker = 'QYLD'" },
  ]),
  "vgi.result_columns_schema": resultColumnsSchema(productsSchema(), PRODUCTS_COLUMN_COMMENTS),
};

/** Per-column comments for the holdings table. */
const HOLDINGS_COLUMN_COMMENTS: Record<string, string> = {
  fund_ticker: "The fund's ticker (e.g. QYLD) — the hive partition key; constant for every row of a fund. Filter on it to pick funds; omit to stream all.",
  as_of_date: "Holdings as-of date (the published file's own date; current holdings only).",
  weight_percent: "Percent of the fund's net assets, in percent points (0.74 = 0.74%; weights sum to ~100).",
  ticker: "Constituent ticker (may carry an exchange suffix like '6104 JP'; blank for cash/derivative lines).",
  name: "Constituent / issue name. Part of the (fund_ticker, name, sedol) primary key; never blank.",
  sedol: "Constituent SEDOL identifier; empty string for cash/derivative lines that carry none. Part of the (fund_ticker, name, sedol) primary key.",
  market_price: "Market price per unit of the constituent, in USD.",
  shares_held: "Number of shares / units held.",
  market_value: "Market value of the position, in USD.",
};

/** Table-level metadata for the holdings base table (ticker-partitioned, current holdings). */
const HOLDINGS_TABLE_TAGS: Record<string, string> = {
  "vgi.category": "holdings",
  domain: "finance",
  "vgi.keywords": JSON.stringify([
    "holdings",
    "constituents",
    "portfolio",
    "weights",
    "positions",
    "exposure",
  ]),
  "vgi.doc_llm":
    "Detailed portfolio holdings for Global X ETFs as a hive-partitioned table. It is partitioned " +
    "by fund_ticker (the FUND's ticker, distinct from the constituent `ticker` column): filter " +
    "`WHERE fund_ticker = '…'` (or `fund_ticker IN (…)`) to pick funds, or scan with no filter to " +
    "stream EVERY fund's holdings (~116 funds — slow, so prefer a filter). Global X publishes " +
    "CURRENT holdings only, so there is no historical as-of date; as_of_date is the published " +
    "file's own date. Rows come back weight-descending; weight_percent is in percent points " +
    "(0.74 = 0.74%). Join on fund_ticker to products.ticker for fund-level facts.",
  "vgi.doc_md":
    "## holdings\n\n" +
    "Detailed fund holdings as a **hive-partitioned table**, partitioned by `fund_ticker` (the " +
    "fund's ticker). `fund_ticker` is distinct from `ticker` (the constituent's own ticker). " +
    "Filter `WHERE fund_ticker = 'QYLD'` for one fund's holdings (see the example queries).\n\n" +
    "`WHERE fund_ticker IN ('QYLD','COPX')` fans out per partition; an unfiltered scan streams " +
    "every fund (~116 partitions — slow). Global X publishes **current holdings only** (no " +
    "historical dates). `weight_percent` is in percent points (0.74 = 0.74%).",
  "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_COLUMN_COMMENTS),
  "vgi.example_queries": JSON.stringify([
    { description: "Top 10 current holdings of QYLD", sql: "SELECT name, ticker, weight_percent FROM globalx.main.holdings WHERE fund_ticker = 'QYLD' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "The largest positions of the Copper Miners ETF", sql: "SELECT name, weight_percent, market_value FROM globalx.main.holdings WHERE fund_ticker = 'COPX' ORDER BY weight_percent DESC LIMIT 10" },
    { description: "Two funds at once (partition fan-out)", sql: "SELECT fund_ticker, name, weight_percent FROM globalx.main.holdings WHERE fund_ticker IN ('QYLD', 'COPX')" },
  ]),
};

/** Catalog-level tags: docs, discovery, provenance, and the agent-test suite. */
const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Global X ETFs",
  "vgi.doc_llm":
    "Global X US ETF data as SQL tables. Reach for it to screen the ETF lineup on key facts (net " +
    "assets, expense ratio, returns, theme), and to inspect what a fund currently holds. The " +
    "central concept is the fund, identified by its exchange ticker (e.g. QYLD); start from the " +
    "catalog to find that key, then drill into a specific fund's holdings. Data is Global X's " +
    "public fund feed: best-effort, for informational use.",
  "vgi.doc_md":
    "## Global X ETFs\n\n" +
    "Global X US ETF data, exposed as DuckDB tables.\n\n" +
    "The **fund** is the unit of the data and is keyed by an exchange `ticker` (e.g. `QYLD`) — " +
    "begin at the catalog to discover that key, then drill into a fund's holdings. Holdings are " +
    "the current published portfolio (Global X does not publish historical holdings).\n\n" +
    "Data is provided for informational use; review Global X's terms before redistribution.",
  "vgi.keywords": JSON.stringify([
    "ETF",
    "Global X",
    "Mirae Asset",
    "holdings",
    "portfolio",
    "fund",
    "covered call",
    "thematic",
    "expense ratio",
    "income",
  ]),
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC",
  "vgi.license": "MIT",
  "vgi.support_contact": ISSUES,
  "vgi.support_policy_url": ISSUES,
  // At least one guaranteed-runnable example at the catalog level (VGI509). No
  // expected_result — Global X data is live/non-deterministic.
  "vgi.executable_examples": JSON.stringify([
    {
      name: "largest_etfs",
      description: "The largest Global X ETFs by net assets",
      sql: "SELECT ticker, fund_name, net_assets FROM globalx.main.products ORDER BY net_assets DESC LIMIT 5",
    },
    {
      name: "top_holdings",
      description: "The top holdings of the Global X Nasdaq 100 Covered Call ETF",
      sql: "SELECT name, ticker, weight_percent FROM globalx.main.holdings WHERE fund_ticker = 'QYLD' ORDER BY weight_percent DESC LIMIT 5",
    },
  ]),
  // Agent-suitability suite (catalog only). Each task carries a deterministic check_sql that
  // asserts specific ground truth; reference_sql is deliberately omitted (live data). One task
  // per callable surface (products, holdings, holdings_scan) satisfies VGI520.
  "vgi.agent_test_tasks": JSON.stringify([
    {
      name: "qyld_exists",
      prompt: "Does Global X offer an ETF with the ticker QYLD, and what is it called?",
      check_sql: "SELECT count(*) > 0 FROM globalx.main.products WHERE ticker = 'QYLD'",
      success_criteria: "The answer confirms QYLD is the Global X Nasdaq 100 Covered Call ETF, found via the products table.",
    },
    {
      name: "qyld_expense_ratio",
      prompt: "What is the gross expense ratio of the Global X Nasdaq 100 Covered Call ETF (QYLD)?",
      check_sql: "SELECT count(*) > 0 FROM globalx.main.products WHERE ticker = 'QYLD' AND gross_expense_ratio_percent IS NOT NULL",
      success_criteria: "The answer reports QYLD's gross expense ratio (a small percentage) from the products table.",
    },
    {
      name: "qyld_top_holding",
      prompt: "What is the single largest holding of the Global X Nasdaq 100 Covered Call ETF (QYLD) right now?",
      check_sql: "SELECT count(*) > 0 FROM globalx.main.holdings WHERE fund_ticker = 'QYLD'",
      success_criteria: "The answer names QYLD's top holding by weight, obtained from the holdings table.",
    },
    {
      name: "qyld_holdings_scan",
      prompt: "Using the holdings backing scan function with the fund ticker as its argument, list a few QYLD constituents by weight.",
      check_sql: "SELECT count(*) > 0 FROM globalx.main.holdings_scan(fund_ticker => 'QYLD')",
      success_criteria: "The answer returns QYLD constituents via holdings_scan(fund_ticker => 'QYLD'), passing the fund ticker as the argument.",
    },
  ]),
};

/** Schema-level tags: docs, discovery, the category registry, and shown examples. */
const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Global X Fund Data",
  "vgi.doc_llm":
    "Global X ETF data at two levels. At the catalog level you screen the whole lineup on key " +
    "facts and resolve a fund's key. At the fund level you drill into one fund's current " +
    "holdings. A fund is keyed by its exchange `ticker` (e.g. `QYLD`); resolve the key at the " +
    "catalog level first.",
  "vgi.doc_md":
    "## Global X fund data\n\n" +
    "Work happens at two levels. **Catalog level:** screen the lineup on key facts and find a " +
    "fund's key. **Fund level:** drill into a single fund's constituents. A fund is keyed by its " +
    "exchange `ticker` (e.g. `QYLD`).\n\n" +
    "Holdings are the current published portfolio; Global X does not publish historical holdings.",
  "vgi.keywords": JSON.stringify(["ETF holdings", "fund catalog", "portfolio", "Global X", "thematic"]),
  domain: "finance",
  // Ordered navigation registry; each `name` is referenced by a function's vgi.category.
  "vgi.categories": JSON.stringify([
    { name: "catalog", title: "Fund Catalog", description: "The ETF product list and per-fund key facts." },
    { name: "holdings", title: "Holdings", description: "Detailed current portfolio holdings." },
  ]),
  "vgi.example_queries": JSON.stringify([
    { description: "Ten largest Global X ETFs by net assets", sql: "SELECT ticker, fund_name, net_assets FROM globalx.main.products ORDER BY net_assets DESC LIMIT 10" },
    { description: "Top holdings of QYLD", sql: "SELECT name, ticker, weight_percent FROM globalx.main.holdings WHERE fund_ticker = 'QYLD' ORDER BY weight_percent DESC LIMIT 10" },
  ]),
};

/**
 * @param functions    the callable table functions — empty for Global X (products and holdings are
 *                      base tables), but the parameter is kept for parity with the sibling workers.
 * @param productsScan  the zero-arg scan backing the `products` base table.
 * @param holdingsScan  the pushdown scan backing the `holdings` base table.
 * Both scans are registered for scan dispatch but exposed to DuckDB only as tables (except that
 * holdingsScan is also LISTED so the extension can push the fund_ticker filter into it).
 */
export function makeCatalog(
  functions: VgiFunction[],
  productsScan: VgiFunction,
  holdingsScan: VgiFunction,
): CatalogDescriptor {
  return {
    name: "globalx",
    defaultSchema: "main",
    comment:
      "Global X US ETF data as DuckDB tables: products (catalog) & holdings (ticker-partitioned, " +
      "current holdings) — vgi-etf-globalx",
    sourceUrl: REPO,
    tags: CATALOG_TAGS,
    schemas: [
      {
        name: "main",
        comment: "Global X fund data: the ETF catalog and detailed current holdings.",
        tags: SCHEMA_TAGS,
        functions: [...functions, holdingsScan],
        tables: [
          {
            name: "products",
            function: productsScan,
            arguments: new Arguments([], new Map()),
            // Each fund is keyed by its exchange ticker (advisory — not enforced on scan).
            primaryKey: [["ticker"]],
            // The Global X US ETF lineup is ~116 funds; headroom to ~250.
            inlinedCardinality: { estimate: 116n, max: 250n },
            comment:
              "Every Global X US ETF with its key facts, one row per fund. Query directly (no " +
              "arguments) and filter with WHERE; percent columns are in percent points.",
            columnComments: PRODUCTS_COLUMN_COMMENTS,
            tags: PRODUCTS_TABLE_TAGS,
          },
          {
            name: "holdings",
            function: holdingsScan,
            arguments: new Arguments([], new Map()),
            // A holding row is identified by its fund + constituent: (fund_ticker, name, sedol) is a
            // NOT-NULL composite primary key, verified unique across every fund's current holdings.
            // A constituent's SEDOL alone is not unique within a fund (a preferred issuer can hold two
            // series under one name/ticker with distinct SEDOLs), and cash/derivative lines carry no
            // SEDOL (emitted as '') — so name is part of the key too. The scan emits '' (never NULL)
            // for a blank name/sedol so the key columns are genuinely non-null.
            notNull: ["fund_ticker", "name", "sedol"],
            primaryKey: [["fund_ticker", "name", "sedol"]],
            // Hive partition key: fund_ticker. A WHERE fund_ticker = … / IN (…) filter is pushed
            // down to fetch just those funds; an unfiltered scan streams every fund (all partitions).
            // Global X publishes current holdings only, so there is NO time travel.
            // Whole-table estimate: ~116 funds × ~100 constituents each. A single-fund filter
            // scans one partition (a bond/preferred fund can reach a few hundred rows).
            inlinedCardinality: { estimate: 12000n, max: 60000n },
            comment:
              "Detailed current fund holdings, hive-partitioned by fund_ticker (filter WHERE " +
              "fund_ticker = … for one fund, or scan unfiltered for all). Global X publishes " +
              "current holdings only (no historical dates).",
            columnComments: HOLDINGS_COLUMN_COMMENTS,
            tags: HOLDINGS_TABLE_TAGS,
          },
        ],
      },
    ],
  };
}
