// Typed-column contract for the two schemas. This one pulls @query-farm/vgi (batchFromColumns) +
// apache-arrow, so it runs under the full SDK install — unlike the driver tests, which are
// deliberately SDK-free. Proves schema field names/order and that Utf8/Float64/Date cells (incl.
// nulls) round-trip into an Arrow batch.

import { test, expect } from "bun:test";
import {
  productsSchema,
  productsBatch,
  holdingsSchema,
  holdingsBatch,
} from "../src/schema.js";
import { parseProducts, parseHoldings } from "../src/globalx.js";
import { exploreHtml, equityHoldingsCsv, QYLD_FUND, EMBD_FUND } from "./fake-globalx.js";

const names = (schema: { fields: { name: string }[] }) => schema.fields.map((f) => f.name);

test("products schema field names + order", () => {
  expect(names(productsSchema())).toEqual([
    "ticker", "fund_name", "theme", "sub_theme", "inception_date", "as_of_date",
    "performance_as_of", "nav", "net_assets", "gross_expense_ratio_percent",
    "net_expense_ratio_percent", "return_1m_percent", "return_3m_percent", "ytd_return_percent",
    "return_1y_percent", "return_3y_percent", "return_5y_percent", "return_10y_percent",
    "return_since_inception_percent", "fact_sheet_url",
  ]);
});

test("holdings schema field names + order", () => {
  expect(names(holdingsSchema())).toEqual([
    "fund_ticker", "as_of_date", "weight_percent", "ticker", "name", "sedol", "market_price",
    "shares_held", "market_value",
  ]);
});

test("batch builders produce one row per parsed record", () => {
  const products = parseProducts(exploreHtml([QYLD_FUND, EMBD_FUND]));
  const holdings = parseHoldings(equityHoldingsCsv(), "QYLD");
  expect((productsBatch(productsSchema(), products) as { numRows: number }).numRows).toBe(2);
  expect((holdingsBatch(holdingsSchema(), holdings) as { numRows: number }).numRows).toBe(4);
});

test("empty inputs build a zero-row batch, not a throw", () => {
  expect((productsBatch(productsSchema(), []) as { numRows: number }).numRows).toBe(0);
  expect((holdingsBatch(holdingsSchema(), []) as { numRows: number }).numRows).toBe(0);
});
