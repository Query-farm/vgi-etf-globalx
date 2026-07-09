// The VGI surfaces: the products & holdings base-table backing scans. All keyless. The products
// state is just a `done` flag (fully serializable — no socket / batch / Date), so the HTTP
// transport can round-trip it; the holdings scan streams via a BoundStorage work queue. The
// Global X client is injected so worker.ts wires the real fetch and tests wire a fake.

import {
  defineTableFunction,
  batchFromColumns,
  serializeBatch,
  deserializeFilters,
  buildJoinKeysLookup,
  DEFAULT_MAX_WORKERS,
  type OutputCollector,
} from "@query-farm/vgi";
import { Schema, Field, Utf8 } from "@query-farm/apache-arrow";
import { fetchProducts, fetchHoldings } from "./globalx.js";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
  resultColumnsSchema,
} from "./schema.js";
import type { GlobalxClient } from "./client.js";

// Per-column descriptions for the `vgi.result_columns_schema` tag (JSON [{name,type,description}],
// generated from the holdings Arrow schema via resultColumnsSchema).
const HOLDINGS_SCAN_DESCS: Record<string, string> = {
  fund_ticker: "The fund's ticker — the partition filter.",
  as_of_date: "The holdings as-of date (the published file's own date).",
  weight_percent: "Percent of the fund's net assets, in percent points (0.74 = 0.74%).",
  ticker: "Constituent ticker (may carry an exchange suffix; blank for cash/derivative lines).",
  name: "Constituent / issue name.",
  sedol: "Constituent SEDOL.",
  market_price: "Market price per unit of the constituent, in USD.",
  shares_held: "Number of shares / units held.",
  market_value: "Market value of the position, in USD.",
};

interface DoneState {
  done: boolean;
}

// ── holdings queue plumbing (BoundStorage work queue + hive partition metadata) ──
//
// The holdings scan streams one fund per partition. `onInit` seeds a BoundStorage queue with the
// target funds (one item each); each `process()` tick pops a fund, fetches its holdings, and emits
// one SINGLE_VALUE partition. Multiple parallel workers drain the same execution-scoped queue, so
// the fan-out is naturally work-stealing and bounded by maxWorkers.

/** A queued fund: its ticker (the partition value) + the catalog as-of hint (epoch seconds). */
interface FundItem {
  ticker: string;
  asOf: number | null;
}
const encodeFund = (item: FundItem): Uint8Array => new TextEncoder().encode(JSON.stringify(item));
const decodeFund = (bytes: Uint8Array): FundItem => JSON.parse(new TextDecoder().decode(bytes));

/** Plain (non-annotated) field used to build the partition-values (min,max) batch. */
const FUND_TICKER_FIELD = new Field("fund_ticker", new Utf8(), true);

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * Build the `vgi_partition_values#b64` batch metadata for a SINGLE_VALUE partition: a 2-row
 * (min,max) Arrow batch over fund_ticker where min == max == the fund's ticker.
 */
function partitionValues(ticker: string): Map<string, string> {
  const batch = batchFromColumns({ fund_ticker: [ticker, ticker] }, new Schema([FUND_TICKER_FIELD]));
  return new Map([["vgi_partition_values#b64", b64encode(serializeBatch(batch))]]);
}

// ── products (backing scan for the products TABLE) ──────────────────────────────
//
// `products` is exposed as a real base TABLE (see catalog.ts `tables`), not a table function, so
// users query `FROM globalx.products` (no parens) and filter with WHERE — no arguments. This
// zero-arg scan is registered only for scan dispatch (it is NOT listed among the catalog's
// callable functions). It returns the full Global X US ETF lineup; a WHERE on ticker / theme
// narrows it.

export function makeProductsScan(client: GlobalxClient) {
  const schema = productsSchema();
  return defineTableFunction<Record<string, never>, DoneState>({
    name: "products",
    description: "Global X US ETF catalog — backing scan for the products table.",
    args: {},
    onBind: () => ({ outputSchema: schema }),
    initialState: () => ({ done: false }),
    process: async (_p, state: DoneState, out: OutputCollector) => {
      if (state.done) {
        out.finish();
        return;
      }
      const rows = await fetchProducts(client.get);
      out.emit(productsBatch(schema, rows));
      state.done = true;
    },
  });
}

// ── holdings (backing scan for the holdings TABLE) ─────────────────────────────
//
// `holdings` is exposed as a base TABLE (see catalog.ts), HIVE-PARTITIONED on `fund_ticker` (the
// fund's ticker — distinct from the constituent `ticker` column). Global X publishes only the
// CURRENT holdings CSV per fund, so — unlike the sibling iShares worker — there is NO time travel
// and no as-of argument; `as_of_date` reflects the file's own publication date.
//   SELECT * FROM globalx.main.holdings WHERE fund_ticker = 'QYLD';
//   SELECT * FROM globalx.main.holdings WHERE fund_ticker IN ('QYLD','COPX');  -- fan-out per partition
//   SELECT * FROM globalx.main.holdings;                                       -- ALL funds (every partition)
//
// Each fund is one SINGLE_VALUE partition. The scan is a streaming, queue-backed generator:
//   • onInit (runs once on the coordinator) reads the pushed fund_ticker filter — or, absent one,
//     the ENTIRE ETF catalog — and pushes one item per fund onto a BoundStorage work queue.
//   • process() pops one fund per tick, fetches its holdings, and emits a single partition batch.
// filterPushdown + being LISTED is what lets DuckDB push fund_ticker into the scan.

export function makeHoldingsScan(client: GlobalxClient) {
  const schema = holdingsSchema();
  return defineTableFunction<Record<string, never>, Record<string, never>>({
    name: "holdings_scan",
    description:
      "Backing scan for the holdings table — prefer the `holdings` table. Detailed fund " +
      "holdings, hive-partitioned by fund_ticker: filter WHERE fund_ticker = 'QYLD' (or " +
      "fund_ticker IN (…)) for specific funds, or scan with no filter to stream every fund's " +
      "holdings. weight_percent is in percent points; Global X publishes current holdings only.",
    args: {},
    // filterPushdown MUST be declared AND this function MUST be listed in the catalog so the DuckDB
    // extension can discover the capability and push the fund_ticker filter into the scan. Each
    // fund is one SINGLE_VALUE partition (fund_ticker is the hive partition key).
    filterPushdown: true,
    partitionKind: "SINGLE_VALUE_PARTITIONS",
    maxWorkers: DEFAULT_MAX_WORKERS,
    onBind: () => ({ outputSchema: schema }),
    // Seed the work queue (once, on the coordinator): one item per target fund, carrying the
    // catalog as-of hint so process() can build the dated CSV URL directly.
    onInit: async ({ initCall, executionId, storage }) => {
      const joinKeys = buildJoinKeysLookup(initCall.join_keys);
      const filters = initCall.pushdown_filters
        ? deserializeFilters(initCall.pushdown_filters, joinKeys)
        : undefined;
      const requested = new Set(
        (filters?.getColumnValues("fund_ticker") ?? []).map((t) => String(t).toUpperCase()),
      );
      // Resolve the fund universe (and each fund's as-of) from the (cached) catalog. One fetch.
      const products = await fetchProducts(client.get);
      const targets: FundItem[] = [];
      const seen = new Set<string>();
      for (const p of products) {
        const tk = (p.ticker ?? "").toUpperCase();
        if (!tk || seen.has(tk)) continue;
        if (requested.size > 0 && !requested.has(tk)) continue;
        seen.add(tk);
        targets.push({ ticker: tk, asOf: p.asOfDate });
      }
      await storage.queuePush(targets.map(encodeFund));
      return { max_workers: DEFAULT_MAX_WORKERS, execution_id: executionId, opaque_data: null };
    },
    initialState: () => ({}),
    process: async (p, _state, out: OutputCollector) => {
      // Pop one fund per tick; emit exactly one partition. Skip funds with no holdings file or an
      // empty file, and pop the next. Queue empty → end of scan.
      for (;;) {
        const item = await p.storage!.queuePop();
        if (item === null) {
          out.finish();
          return;
        }
        const fund = decodeFund(item);
        const rows = await fetchHoldings(client.get, fund.ticker, { asOfHint: fund.asOf });
        if (rows.length === 0) continue;
        out.emit(holdingsBatch(schema, rows), partitionValues(fund.ticker));
        return;
      }
    },
    examples: [
      { sql: "SELECT name, weight_percent FROM globalx.main.holdings_scan() WHERE fund_ticker = 'QYLD' ORDER BY weight_percent DESC LIMIT 10", description: "Top 10 holdings of QYLD via the backing scan" },
      { sql: "SELECT fund_ticker, count(*) FROM globalx.main.holdings_scan() WHERE fund_ticker IN ('QYLD', 'COPX') GROUP BY fund_ticker", description: "Two partitions at once (fan-out)" },
    ],
    tags: {
      "vgi.category": "holdings",
      "vgi.doc_llm":
        "The backing scan for the `holdings` table. Prefer querying the `holdings` table. " +
        "Hive-partitioned by fund_ticker (the fund's ticker, distinct from the constituent " +
        "`ticker` column): filter WHERE fund_ticker = '…' (or fund_ticker IN (…)) for specific " +
        "funds, or scan with no filter to stream every fund (~116 partitions — slow). " +
        "weight_percent is in percent points (0.74 = 0.74%). Global X publishes current holdings " +
        "only, so there is no historical as-of date.",
      "vgi.doc_md":
        "## holdings_scan\n\n" +
        "The backing scan for the **`holdings` table** — prefer the table. Hive-partitioned by " +
        "`fund_ticker`: filter `WHERE fund_ticker = 'QYLD'` for one fund, or scan with no filter " +
        "to stream every fund (see the example queries). `fund_ticker` is distinct from the " +
        "constituent `ticker` column.",
      "vgi.result_columns_schema": resultColumnsSchema(holdingsSchema(), HOLDINGS_SCAN_DESCS),
    },
  });
}
