# SDK lint contract exceptions

[App issue #21876](https://github.com/0xinsider/0xinsider/issues/21876) and [source companion #26](https://github.com/0xinsider/0xinsider-node/issues/26) preserve these established SDK contracts while enabling typed Oxlint checks. Verified on 2026-10-06 with Oxlint 1.85.0 and TypeScript 7.0.2. The exceptions are configured in `.oxlintrc.json`; they do not remove deprecation tags, suppress source diagnostics, or permit arbitrary `any` rejection reasons.

## Named compatibility declarations

`typescript/no-deprecated` remains an error. Its allowlist matches only these declarations in their owning files:

| Owner | Allowed declarations | Contract |
| --- | --- | --- |
| `src/client.ts:1343` | `SportsEdgeSignalsParams` | Existing alias for `PreGameSidesParams` |
| `src/client.ts:1422` | `SportsEdgeObservationsResponse` | Existing alias for `PreGameSideObservationsResponse` |
| `src/client.ts:1428` | `SportsEdgeObservationsParams` | Existing alias for `PreGameSideObservationsParams` |
| `src/client.ts:1855` | `WhaleTradeListParams` | Parameters of the retained large-trade endpoint alias |
| `src/client.ts:1858` | `WhaleTradeHistoryParams` | Parameters of the retained history endpoint alias |
| `src/client.ts:1878` | `InsiderRadarListParams` | Existing alias for `SuspiciousTradesListParams` |
| `src/webhooks.ts:324` | `InsiderRadarFlagRaisedData` | Existing suspicious-trade payload alias |
| `src/webhooks.ts:415` | `InsiderRadarFlagRaisedEvent` | Retained `insider_radar_flag_raised` event discriminant |
| `src/webhooks.ts:423` | `SmartMoneyFlowDetectedData` | Existing sharp-money payload alias |
| `src/webhooks.ts:436` | `SmartMoneyFlowDetectedEvent` | Retained `smart_money_flow_detected` event discriminant |

The public barrel and webhook union must reference these declarations to retain source compatibility and the event discriminants delivered to existing subscriptions. Removing their exports, substituting the new discriminants, or deleting `@deprecated` would change the public contract. New deprecated vendor calls receive no allowance.

[Oxc's rule reference](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-deprecated) documents named file specifiers for intentional compatibility references.

## Caller abort reasons

`typescript/prefer-promise-reject-errors` remains an error. Only `src/retry.ts` and `src/stream.ts` enable `allowThrowingUnknown: true`; `allowThrowingAny` remains false. Each rejected caller reason is first stored as `unknown` at `retry.ts:126`, `retry.ts:132`, or `stream.ts:355`.

[Node's AbortController contract](https://nodejs.org/api/globals.html#abortcontrollerabortreason) accepts any JavaScript value as `reason`. The existing SDK propagates that exact reason. Wrapping a custom string, object, or symbol in `Error` would change its identity, so the SDK preserves it without treating it as a typed Error. [Oxc's rule reference](https://oxc.rs/docs/guide/usage/linter/rules/typescript/prefer-promise-reject-errors) documents the separate unknown and any options; the installed configuration schema confirms both options.

## Generator cleanup failures

`eslint/no-unsafe-finally` is disabled only for `src/stream.ts`. The audited site is `stream.ts:696`: `streamFeed` cancels its owned body and releases its reader when an iteration finishes, throws, or the consumer exits early. A cancellation failure must remain visible during `AsyncGenerator.return()`. Moving its throw after `finally` loses that diagnostic when the consumer stops the generator.

When a primary operation already failed, `withStreamCleanupCause` retains its Error instance and HTTP classification while attaching cleanup evidence; if annotation itself fails, it returns an AggregateError retaining the primary cause. When no primary failure occurred, the cleanup Error is surfaced. Removing this behavior would hide a stream ownership failure. The exception applies to this file; it does not weaken the rule elsewhere.

## Recheck

```sh
npm run check
npm run check-types
npm run lint
npm run build
npm run check:examples
npm pack --dry-run
```

These checks validate the committed OpenAPI snapshot, compilation, typed lint, the documented consumer example and package contents. No tests are modified or run.
