// Arrow output schemas + row→batch mapping for the products / holdings surfaces.
//
// Global X data has a STABLE, known shape, so we emit real typed columns (not a single JSON
// string): Utf8 identifiers/names, Float64 prices/weights/returns, and a real Arrow DATE
// (Date32) for every calendar date. `batchFromColumns` defaults to the "rich" representation,
// so a DATE cell is a JS `Date` (at UTC midnight). Percent-valued columns carry a `_percent`
// suffix and hold percent-magnitude numbers (e.g. 7.38 = 7.38%); the driver already scales
// Global X's fractional returns to percent points before they reach here.

import { Schema, Field, Utf8, Float64, DateDay } from "@query-farm/apache-arrow";
import { batchFromColumns } from "@query-farm/vgi";
import type { ProductRow, HoldingRow } from "./globalx.js";

const f = (name: string, type: ConstructorParameters<typeof Field>[1]) => new Field(name, type, true);
const date = () => new DateDay();

/**
 * A hive-style partition-column field: carries `vgi.partition_column = "true"` so the DuckDB
 * binder treats it as a partition key. `holdings` is partitioned on `fund_ticker` — each scanned
 * fund is one SINGLE_VALUE partition (see makeHoldingsScan). Mirrors vgi's `partition_field`.
 */
const partitionField = (name: string, type: ConstructorParameters<typeof Field>[1]) =>
  new Field(name, type, true, new Map([["vgi.partition_column", "true"]]));

/** Map an Arrow field type to the DuckDB type name shown in docs. */
function duckdbType(type: unknown): string {
  const n = (type as { constructor?: { name?: string } })?.constructor?.name ?? "";
  if (n.startsWith("Utf8")) return "VARCHAR";
  if (n.startsWith("Float")) return "DOUBLE";
  if (n.startsWith("Int") || n.startsWith("Uint")) return "BIGINT";
  if (n.startsWith("Date")) return "DATE";
  return "VARCHAR";
}

/**
 * Build the `vgi.result_columns_schema` tag value (a JSON array of {name, type, description})
 * for a static result schema, DRY from the Arrow schema + a name→description map.
 */
export function resultColumnsSchema(schema: Schema, descriptions: Record<string, string>): string {
  return JSON.stringify(
    schema.fields.map((field) => ({
      name: field.name,
      type: duckdbType(field.type),
      description: descriptions[field.name] ?? field.name,
    })),
  );
}

/** JS Date | null for a DATE (Date32) cell from epoch SECONDS at UTC midnight. */
const dateOrNull = (sec: number | null): Date | null => (sec == null ? null : new Date(sec * 1000));

// ── products ──────────────────────────────────────────────────────────────────

export function productsSchema(): Schema {
  return new Schema([
    f("ticker", new Utf8()),
    f("fund_name", new Utf8()),
    f("theme", new Utf8()),
    f("sub_theme", new Utf8()),
    f("inception_date", date()),
    f("as_of_date", date()),
    f("performance_as_of", date()),
    f("nav", new Float64()),
    f("net_assets", new Float64()),
    f("gross_expense_ratio_percent", new Float64()),
    f("net_expense_ratio_percent", new Float64()),
    f("return_1m_percent", new Float64()),
    f("return_3m_percent", new Float64()),
    f("ytd_return_percent", new Float64()),
    f("return_1y_percent", new Float64()),
    f("return_3y_percent", new Float64()),
    f("return_5y_percent", new Float64()),
    f("return_10y_percent", new Float64()),
    f("return_since_inception_percent", new Float64()),
    f("fact_sheet_url", new Utf8()),
  ]);
}

export function productsBatch(schema: Schema, rows: ProductRow[]) {
  return batchFromColumns(
    {
      ticker: rows.map((r) => r.ticker),
      fund_name: rows.map((r) => r.fundName),
      theme: rows.map((r) => r.theme),
      sub_theme: rows.map((r) => r.subTheme),
      inception_date: rows.map((r) => dateOrNull(r.inceptionDate)),
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      performance_as_of: rows.map((r) => dateOrNull(r.performanceAsOf)),
      nav: rows.map((r) => r.nav),
      net_assets: rows.map((r) => r.netAssets),
      gross_expense_ratio_percent: rows.map((r) => r.grossExpenseRatioPercent),
      net_expense_ratio_percent: rows.map((r) => r.netExpenseRatioPercent),
      return_1m_percent: rows.map((r) => r.return1mPercent),
      return_3m_percent: rows.map((r) => r.return3mPercent),
      ytd_return_percent: rows.map((r) => r.ytdReturnPercent),
      return_1y_percent: rows.map((r) => r.return1yPercent),
      return_3y_percent: rows.map((r) => r.return3yPercent),
      return_5y_percent: rows.map((r) => r.return5yPercent),
      return_10y_percent: rows.map((r) => r.return10yPercent),
      return_since_inception_percent: rows.map((r) => r.returnSinceInceptionPercent),
      fact_sheet_url: rows.map((r) => r.factSheetUrl),
    },
    schema,
  );
}

// ── holdings ────────────────────────────────────────────────────────────────

export function holdingsSchema(): Schema {
  return new Schema([
    // fund_ticker is the hive partition key: holdings_scan emits one SINGLE_VALUE partition per fund.
    partitionField("fund_ticker", new Utf8()),
    f("as_of_date", date()),
    f("weight_percent", new Float64()),
    f("ticker", new Utf8()),
    f("name", new Utf8()),
    f("sedol", new Utf8()),
    f("market_price", new Float64()),
    f("shares_held", new Float64()),
    f("market_value", new Float64()),
  ]);
}

export function holdingsBatch(schema: Schema, rows: HoldingRow[]) {
  // `name` and `sedol` are part of the holdings composite primary key
  // (fund_ticker, name, sedol), so they must be non-null: coerce a blank/absent
  // value to the empty string (cash & derivative lines carry no SEDOL). Verified
  // unique across every fund's current holdings.
  const orEmpty = (s: string | null): string => s ?? "";
  return batchFromColumns(
    {
      fund_ticker: rows.map((r) => r.fundTicker),
      as_of_date: rows.map((r) => dateOrNull(r.asOfDate)),
      weight_percent: rows.map((r) => r.weightPercent),
      ticker: rows.map((r) => r.ticker),
      name: rows.map((r) => orEmpty(r.name)),
      sedol: rows.map((r) => orEmpty(r.sedol)),
      market_price: rows.map((r) => r.marketPrice),
      shares_held: rows.map((r) => r.sharesHeld),
      market_value: rows.map((r) => r.marketValue),
    },
    schema,
  );
}
