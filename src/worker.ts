// vgi-etf-globalx stdio worker entry. DuckDB spawns this and ATTACHes it:
//   LOAD vgi;
//   ATTACH 'globalx' AS globalx (TYPE vgi, LOCATION '/path/to/vgi-etf-globalx/bin/vgi-etf-globalx-worker');
//   SELECT * FROM globalx.products ORDER BY net_assets DESC LIMIT 10;
//   SELECT * FROM globalx.holdings WHERE fund_ticker = 'QYLD' ORDER BY weight_percent DESC LIMIT 10;
//
// What this worker serves is defined once in src/parts.ts and shared with the
// HTTP entrypoint (scripts/serve.ts).

import { Worker } from "@query-farm/vgi";
import { makeWorkerParts } from "./parts.js";

const { servedFunctions, catalogInterface } = makeWorkerParts();

// `functions` for the Worker is the full set the registry serves (incl. the table scans).
new Worker({ functions: servedFunctions, catalogInterface }).run();
