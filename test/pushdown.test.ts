// Regression: the holdings scan declares filterPushdown, and DuckDB drops every predicate it
// pushes into the scan from its own plan. The scan therefore has to apply ALL pushed filters to
// each fund's batch — not only the fund_ticker partition key it uses to pick funds — or
// `WHERE ticker = 'NVDA'` returns every holding of every fund.

import { test, expect } from "bun:test";
import { PushdownFilters, ComparisonOp } from "@query-farm/vgi";
import { Field, Utf8 } from "@query-farm/apache-arrow";
import { applyPushedFilters } from "../src/functions.js";
import { holdingsSchema, holdingsBatch } from "../src/schema.js";
import { parseHoldings } from "../src/globalx.js";
import { equityHoldingsCsv } from "./fake-globalx.js";

/** A one-predicate `<column> = '<value>'` filter set, as the extension would push it. */
function eqFilter(column: string, value: string): PushdownFilters {
  const index = holdingsSchema().fields.findIndex((f) => f.name === column);
  const expression = {
    node: "comparison" as const,
    op: ComparisonOp.EQ,
    left: { node: "column_ref" as const, columnIndex: index, columnName: column },
    right: { node: "literal" as const, valueRef: 0, field: new Field("v", new Utf8(), true) as never, value },
  };
  return new PushdownFilters(
    [{ id: "p0", revision: 0, mode: "required", source: "query", expression }],
    { profile: "vgi.duckdb.standard.v1" },
    { outputSchema: holdingsSchema() } as never,
  );
}

const ticker = (batch: unknown, row: number): unknown =>
  (batch as { getChild(n: string): { get(i: number): unknown } }).getChild("ticker").get(row);

test("applyPushedFilters keeps only rows matching a pushed non-partition filter", () => {
  const rows = parseHoldings(equityHoldingsCsv(), "QYLD");
  const batch = holdingsBatch(holdingsSchema(), rows);
  const wanted = rows.find((r) => r.ticker)!.ticker!;
  const filtered = applyPushedFilters(eqFilter("ticker", wanted), batch);
  expect(batch.numRows).toBeGreaterThan(1);
  expect(filtered.numRows).toBe(rows.filter((r) => r.ticker === wanted).length);
  expect(ticker(filtered, 0)).toBe(wanted);
});

test("applyPushedFilters drops every row when no holding matches", () => {
  const batch = holdingsBatch(holdingsSchema(), parseHoldings(equityHoldingsCsv(), "QYLD"));
  expect(applyPushedFilters(eqFilter("ticker", "NO-SUCH-TICKER"), batch).numRows).toBe(0);
});

test("applyPushedFilters is a no-op without pushed filters", () => {
  const batch = holdingsBatch(holdingsSchema(), parseHoldings(equityHoldingsCsv(), "QYLD"));
  expect(applyPushedFilters(undefined, batch)).toBe(batch);
});
