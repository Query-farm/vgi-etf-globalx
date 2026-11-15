// HTTP-transport smoke test.
//
// Every other test drives the worker over the *stdio* transport (DuckDB spawns
// `bin/vgi-etf-globalx-worker` and talks to it over stdin/stdout; the haybarn suite exercises that).
// This one stands the SAME registry + catalog up behind the stateless HTTP handler
// (`createVgiFetch`, the Cloudflare/Bun HTTP seam), serves it with `Bun.serve`, and drives it
// end-to-end with the high-level `VgiClient` over `httpConnect`.
//
// It proves the design claim — that the `{done}` function state is serializable enough to
// round-trip through a stateless HTTP request (state is carried in a signed token between
// requests, not held in memory).
//
// Coverage:
//   - protocol handshake over HTTP (catalogs / attach)               [network-free]
//   - the products/holdings tables + holdings_scan are exposed over HTTP [network-free]
//   - a full products scan round-trips over HTTP                     [live: Global X]
//
// The final scan hits Global X live (like the haybarn live-invariant asserts) — fine for an egress
// connector. Schema columns are deterministic; only row content is live.
//
// RATE LIMIT: globalxetfs.com rate-limits shared CI egress (GitHub runners get HTTP 429). The
// client already retries 429/503 with backoff; if Global X STILL answers 429 after those retries,
// the live test is reported as SKIPPED (with the reason printed), not failed — a rate limit says
// nothing about the worker. Any other failure (including other HTTP errors) still fails the test.
// The probe warms the shared client's 24 h Explore cache, so the scan itself makes no new request.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { createVgiFetch } from "@query-farm/vgi/worker-cf";
import { FunctionRegistry, ReadOnlyCatalogInterface, VgiClient, Arguments } from "@query-farm/vgi";
import { httpConnect } from "@query-farm/vgi-rpc";
import { makeProductsScan, makeHoldingsScan } from "../src/functions.js";
import { makeCatalog } from "../src/catalog.js";
import { makeGlobalxClient } from "../src/client.js";
import { EXPLORE_URL } from "../src/globalx.js";
import pkg from "../package.json" with { type: "json" };

const PREFIX = "/vgi";
// Static 32-byte HMAC key — the HTTP handler signs state tokens with it.
const SIGNING_KEY = new Uint8Array(32).fill(7);

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

const client = makeGlobalxClient();

// Probe Global X once, up front (top-level await, so the skip decision exists at registration).
// Only a rate limit is a skip; any other probe error is kept and re-thrown by the live test (so it
// fails there, without taking down the network-free tests in this file).
let liveSkipReason: string | null = null;
let liveProbeError: unknown = null;
try {
  await client.get(EXPLORE_URL);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/HTTP 429\b/.test(msg)) liveProbeError = e;
  else liveSkipReason = `Global X rate-limited this host (HTTP 429 from ${EXPLORE_URL} after retries)`;
}
if (liveSkipReason) {
  console.warn(`SKIP products table scan round-trips over HTTP (live): ${liveSkipReason}`);
}

beforeAll(() => {
  const functions: never[] = [];
  const productsScan = makeProductsScan(client);
  const holdingsScan = makeHoldingsScan(client);
  const registry = new FunctionRegistry();
  registry.register(productsScan);
  registry.register(holdingsScan);
  const catalogInterface = new ReadOnlyCatalogInterface(
    makeCatalog(functions, productsScan, holdingsScan),
    registry,
  );

  const fetch = createVgiFetch({
    protocol: { registry, catalogInterface },
    signingKey: SIGNING_KEY,
    prefix: PREFIX,
    landingInfo: { name: "globalx", doc: "Global X ETF data", version: pkg.version },
  });

  server = Bun.serve({ port: 0, fetch });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
});

test("catalog is discoverable over HTTP", async () => {
  const rpc = httpConnect(baseUrl, { prefix: PREFIX });
  try {
    const client = new VgiClient(rpc);
    expect(await client.catalogs()).toContain("globalx");
  } finally {
    rpc.close();
  }
});

test("the products/holdings tables and holdings_scan are exposed over HTTP", async () => {
  const rpc = httpConnect(baseUrl, { prefix: PREFIX });
  try {
    const client = new VgiClient(rpc);
    const attach = await client.catalogAttach("globalx");
    const fns = await client.schemaContentsFunctions(attach.attach_opaque_data, "main", "TABLE_FUNCTION");
    // holdings_scan is declared in the schema's functions, so it stays public. Protocol 3.3 also
    // sends products' backing scan (so the extension sees its capabilities) but as table_only:
    // hidden from duckdb_functions() and not callable from SQL.
    const isPublic = (f: { visibility?: string | null }) => (f.visibility ?? "public") === "public";
    expect(fns.filter(isPublic).map((f) => f.name).sort()).toEqual(["holdings_scan"]);
    expect(fns.filter((f) => !isPublic(f)).map((f) => [f.name, f.visibility])).toEqual([["products", "table_only"]]);
    // products and holdings are base TABLES.
    const tables = await client.schemaContentsTables(attach.attach_opaque_data, "main");
    expect(tables.map((t) => t.name).sort()).toEqual(["holdings", "products"]);
  } finally {
    rpc.close();
  }
});

test.skipIf(liveSkipReason !== null)("products table scan round-trips over HTTP (live)", async () => {
  if (liveProbeError) throw liveProbeError;
  const rpc = httpConnect(baseUrl, { prefix: PREFIX });
  try {
    const client = new VgiClient(rpc);
    const attach = await client.catalogAttach("globalx");

    const rows: Record<string, any>[] = [];
    // Scan via the table's backing function (registered as "products").
    for await (const batch of client.tableFunctionRows({
      functionName: "products",
      arguments: new Arguments([], new Map()),
      attachOpaqueData: attach.attach_opaque_data,
    })) {
      rows.push(...batch);
    }

    // Live: Global X lists ~116 ETFs.
    expect(rows.length).toBeGreaterThan(50);
    // Deterministic: the typed schema round-tripped intact over HTTP.
    const cols = Object.keys(rows[0]!).sort();
    expect(cols).toContain("ticker");
    expect(cols).toContain("fund_name");
    expect(cols).toContain("net_assets");
    // Live invariant: QYLD is in the ETF list.
    expect(rows.some((r) => r.ticker === "QYLD")).toBe(true);
  } finally {
    rpc.close();
  }
});
