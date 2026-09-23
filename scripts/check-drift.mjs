#!/usr/bin/env node
// The SDK's drift gate, run against the published OpenAPI document.
//
//   node scripts/check-drift.mjs                   # against https://0xinsider.com/api/v1/openapi.json
//   node scripts/check-drift.mjs --spec openapi.json
//
// Runs scripts/app/check-sdk-openapi-drift.mjs, the app repository's own gate
// copied verbatim by scripts/sync-from-app.mjs: every published operation is in
// the client's matching table with the right response kind, every documented
// query parameter has a typed spelling, the Idempotency-Key operations agree,
// and src/schema.ts is what the app's generator renders for this document.
// Against the committed snapshot it is deterministic and needs no network;
// against the live document it answers "is this release behind the API".

import { loadSpec, specArgument } from "./generate.mjs";
import { runAppScript } from "./app-shim.mjs";

try {
  const { raw } = await loadSpec(specArgument());
  process.exit(runAppScript("check-sdk-openapi-drift.mjs", raw));
} catch (error) {
  console.error(`check-drift: ${error.message}`);
  process.exit(1);
}
