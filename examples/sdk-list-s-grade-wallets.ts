/**
 * End-to-end @0xinsider/sdk example: find S-grade wallets, then open a filtered
 * live stream.
 *
 * 1. Construct the client with an `oxi_sk_live_*` key.
 * 2. List S-grade wallets on the leaderboard (auto-paginated).
 * 3. List the S-grade whale trades (cursor pagination over the list envelope).
 * 4. Open an SSE stream filtered to S-grade whale-trade frames.
 *
 * Run (after `npm run build`):
 *   OXINSIDER_API_KEY=oxi_sk_live_... node --loader tsx examples/sdk-list-s-grade-wallets.ts
 *
 * This file is type-checked (`npx tsc --ignoreConfig --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 --skipLibCheck --types node examples/sdk-list-s-grade-wallets.ts`); it does
 * not run network calls during the build.
 */

import { OxinsiderApiClient, paginate, streamFeed } from "../src/index.js";

// No hand-written row shapes: `paginate` and every convenience method are
// typed by their operation (#16136), so `wallet` below is the leaderboard's
// own `LeaderboardEntry` and `trade` the route's `WhaleTrade`.

async function main(): Promise<void> {
  const apiKey = process.env.OXINSIDER_API_KEY;
  if (!apiKey) {
    throw new Error("Set OXINSIDER_API_KEY (oxi_sk_live_...)");
  }

  const client = new OxinsiderApiClient({ apiKey });

  // 1. Leaderboard wallets, paginated; the board holds only S, A and B, and
  //    its query has no min_grade (the type refuses one). paginate() follows
  //    next_cursor across pages and filters to S here.
  console.log("S-grade leaderboard wallets:");
  let walletCount = 0;
  for await (const wallet of paginate(client, "listLeaderboard", {
    query: { limit: 100 },
    maxPages: 5,
  })) {
    if (wallet.grade !== "S") continue;
    walletCount += 1;
    console.log(`  ${wallet.address}  grade=${wallet.grade}`);
  }
  console.log(`  (${walletCount} wallets)`);

  // 2. The most recent S-grade whale trades via the typed list helper.
  const trades = await client.listWhaleTrades({ min_grade: "S", limit: 25 });
  console.log(`\nLatest S-grade whale trades (cost=${String(trades.meta.cost)}):`);
  for (const trade of trades.data) {
    console.log(
      `  ${trade.trader.address} ${trade.size_usd} @ ${trade.price} on ${trade.market.condition_id}`,
    );
  }

  // 3. Open a filtered SSE stream: only S-grade whale-trade frames. Abort after
  //    a short demo window. cursor.seq tracks the last DELIVERED seq -- it says
  //    the frame arrived, never that handling it succeeded. A consumer that
  //    must not drop work uses consumeStreamCheckpointed, whose checkpoint
  //    advances only after the handler and the caller's own durable write
  //    resolve (#16247).
  console.log("\nOpening filtered live stream (Ctrl-C to stop)...");
  const cursor: { seq?: number } = {};
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30_000);

  try {
    for await (const frame of streamFeed(client, {
      event: ["WhaleTradesInserted"],
      min_grade: "S",
      cursor,
      signal: controller.signal,
      onResync: (marker) =>
        console.log("  resync:", marker.completeness?.reason ?? "refetch state"),
    })) {
      if (frame.kind === "event") {
        console.log(`  frame seq=${frame.seq} type=${frame.envelope.type}`);
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  }
  console.log(`Stream closed. Resume from seq=${cursor.seq ?? "head"}.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
