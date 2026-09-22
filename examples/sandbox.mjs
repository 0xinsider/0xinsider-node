// The zero-credential sandbox: https://0xinsider.com/sandbox answers every
// documented operation with example data and never touches production data.
//
// Run (no key needed):
//   npm run build && node examples/sandbox.mjs
//
// In your own project, import from "@0xinsider/sdk" instead of "../dist/index.js".

import { OxinsiderApiClient, RateLimitedError } from "../dist/index.js";

const client = OxinsiderApiClient.sandbox();

const board = await client.listLeaderboard({ limit: 5 });
console.log(`leaderboard (sandbox=${String(board.meta.sandbox)}):`);
for (const wallet of board.data) {
  console.log(`  ${wallet.address}  grade=${wallet.grade}`);
}

// Any error an operation documents, on demand, as the class production throws.
try {
  await client.getTrader("swisstony", { query: { sandbox_status: 429 }, maxRetries: 0 });
} catch (error) {
  if (!(error instanceof RateLimitedError)) throw error;
  console.log(`rate limited: ${error.code}, retry after ${String(error.retryAfterSeconds)} s`);
}
