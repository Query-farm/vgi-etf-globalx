// vgi-etf-globalx stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'globalx' AS globalx (TYPE vgi, LOCATION '/path/to/vgi-etf-globalx/bin/vgi-etf-globalx-worker');
//   SELECT * FROM globalx.products ORDER BY net_assets DESC LIMIT 10;
//   SELECT * FROM globalx.holdings WHERE fund_ticker = 'QYLD' ORDER BY weight_percent DESC LIMIT 10;
//
// Keyless: no CREATE SECRET is needed. `products` and `holdings` are base TABLES (backed by scan
// functions); there are no other callable functions. All take the injected HTTP client (client.ts).

import { Worker, ReadOnlyCatalogInterface, FunctionRegistry } from "@query-farm/vgi";
import { makeGlobalxClient } from "./client.js";
import { makeProductsScan, makeHoldingsScan } from "./functions.js";
import { makeCatalog } from "./catalog.js";

const client = makeGlobalxClient();

// No callable table functions — products and holdings are base tables. The parameter is kept for
// parity with the sibling workers' makeCatalog signature.
const functions: never[] = [];

// Backing scans for the base tables: registered so scan RPCs resolve. products' scan stays
// unlisted (exposed only as the `products` table); holdings' scan is LISTED (in makeCatalog) so
// the extension can push the fund_ticker filter into the `holdings` table.
const productsScan = makeProductsScan(client);
const holdingsScan = makeHoldingsScan(client);

const registry = new FunctionRegistry();
registry.register(productsScan);
registry.register(holdingsScan);

const catalogInterface = new ReadOnlyCatalogInterface(
  makeCatalog(functions, productsScan, holdingsScan),
  registry,
);

// `functions` for the Worker is the full set the registry serves (the table scans).
new Worker({ functions: [productsScan, holdingsScan], catalogInterface }).run();
