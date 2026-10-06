/**
 * @0xinsider/sdk - official TypeScript SDK for the 0xinsider API.
 *
 * Analytics for Polymarket sports and esports markets: wallet grades, large
 * trades, profitable-wallet flows, market flow/candles, the live SSE feed, and
 * webhooks. Checked
 * against the repository's public OpenAPI contract (`web/public/api/v1/openapi.json`).
 *
 * @example
 * import { OxinsiderApiClient, paginate, streamFeed, verifySignature } from "@0xinsider/sdk";
 *
 * const client = new OxinsiderApiClient({ apiKey: process.env.OXINSIDER_API_KEY });
 * const board = await client.listLeaderboard({ strategy: "swing_trader", limit: 100 });
 */

// One default decision over a response's data_quality block (#16965)
export { assessDataQuality } from "./data-quality.js";
export type {
  AssessDataQualityOptions,
  DataQualityAssessment,
  DataQualityFailure,
} from "./data-quality.js";

// Client + core request/response types
export {
  API_CLIENT_OPERATIONS,
  BATCH_TRADER_EXPANSIONS,
  DEFAULT_BASE_URL,
  IDEMPOTENT_WRITE_OPERATIONS,
  MCP_METHODS,
  READ_ONLY_POST_OPERATIONS,
  CONVERGENT_WRITE_OPERATIONS,
  REDIRECT_OPERATIONS,
  UNSUPPORTED_OPERATIONS,
  retryEligibility,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  SANDBOX_BASE_URL,
  assertTrustedBaseUrl,
  resolveApiUrl,
  composeSignals,
  GRADES,
  LEADERBOARD_STRATEGIES,
  OxinsiderApiClient,
  interpolatePath,
  isApiNotModifiedResponse,
  isListEnvelope,
} from "./client.js";
export type {
  ApiClientMethod,
  ApiClientOperation,
  ApiClientOptions,
  ApiClientResponse,
  ApiEnvelope,
  ApiListEnvelope,
  ApiNotModifiedResponse,
  ApiOperationId,
  ApiQueryValue,
  ApiRedirectOperation,
  ApiRequestOptions,
  ApiUnsupportedOperation,
  AuthMode,
  BatchGetTradersOptions,
  BatchTraderExpand,
  CategorySkillStatus,
  CategorySkillStatusCounts,
  ClientMeta,
  ConvenienceOptions,
  EnvelopeOperationId,
  ExploreMarketsParams,
  Game,
  GamesListParams,
  Grade,
  IdempotentWriteOperationId,
  InsiderRadarListParams,
  JsonRpcOperationId,
  LargePositionsListParams,
  ListOperationId,
  ListParams,
  McpJsonRpcRequest,
  McpJsonRpcResponse,
  McpMethod,
  McpOptions,
  McpResult,
  OperationEnvelope,
  OperationItem,
  OperationMeta,
  OperationOptionsArgs,
  OperationRequestOptions,
  OperationRequiresOptions,
  OptionalInputOperationId,
  RuntimeOperationId,
  OperationResult,
  PositionsListParams,
  ResponseKind,
  RetryEligibility,
  SseOperationId,
  TextOperationId,
  TraderExportDownload,
  TraderExportDownloadIntegrity,
  TraderExportDownloadOptions,
  TraderExportDownloadTarget,
  SharpMoneyFlowsParams,
  PickQualifyingExpert,
  PreGameSidesParams,
  PreGameSideObservationsParams,
  PreGameSideObservationsResponse,
  SportsEdgeSignalsParams,
  SportsEdgeObservationBoardUnavailableScope,
  SportsEdgeObservationBoardUpcomingStatus,
  SportsEdgeObservationCohort,
  SportsEdgeObservationDirectionalStatus,
  SportsEdgeObservationOutcomeIndex,
  SportsEdgeObservationProviderSource,
  SportsEdgeObservationSport,
  SportsEdgeObservationTopGrade,
  SportsEdgeObservationsParams,
  SportsEdgeObservationsResponse,
  SuspiciousTradesListParams,
  TennisTour,
  LargeTradeHistoryParams,
  WhaleTradeHistoryParams,
  LeaderboardListParams,
  LeaderboardStrategy,
  TrendingWalletsParams,
  LargeTradeListParams,
  WhaleTradeListParams,
} from "./client.js";

// Error hierarchy
export {
  API_ERROR_CODES,
  API_ERROR_REASONS,
  AccountLockedError,
  BadRequestError,
  CursorExpiredError,
  ExportIntegrityError,
  ForbiddenError,
  IdempotencyInProgressError,
  InternalServerError,
  InvalidApiKeyError,
  InvalidResponseError,
  NotFoundError,
  OxinsiderApiError,
  PickNotReleasedError,
  RateLimitUnavailableError,
  RequestTimeoutError,
  ResponseBodyReadError,
  ServerTimeoutError,
  RateLimitedError,
  ReadModelWarmingError,
  DatabaseUnavailableError,
  RequestAccountingUnavailableError,
  FreshnessCeilingUnsatisfiedError,
  SandboxApiKeyError,
  ApiKeyInQueryError,
  SubscriptionRequiredError,
  TraderNotTrackedError,
  UnknownEndpointError,
  UnknownQueryParameterError,
  WebhookDeliveryInProgressError,
  errorFromResponse,
  extractApiErrorBody,
} from "./errors.js";
export type {
  ApiErrorCode,
  ApiErrorMeta,
  ApiErrorTransportMetadata,
  ApiErrorReason,
  FreshnessFailure,
} from "./errors.js";

// Pagination
export {
  CURSOR_HISTORY_LIMIT,
  PaginationError,
  collect,
  paginate,
  paginatePages,
  paginationResumePoint,
} from "./pagination.js";
export type {
  OperationPaginateOptions,
  PaginateOptions,
  PaginationErrorReason,
  PaginationProgress,
  PaginationResumePoint,
  PaginationStop,
} from "./pagination.js";

// Retry-After parsing and bounded waits, shared by REST and SSE (#16249)
export {
  MAX_TIMER_DELAY_MS,
  RETRY_AFTER_CEILING_MS,
  parseRetryAfter,
} from "./retry.js";

// SSE stream
export {
  DEFAULT_MAX_HANDLER_RETRIES,
  DEFAULT_MAX_STREAM_FRAME_BYTES,
  DEFAULT_MAX_STREAM_ERROR_BODY_BYTES,
  DEFAULT_MAX_STREAM_RECONNECTS,
  DEFAULT_MAX_STREAM_RETRY_AFTER_MS,
  StreamHandlerFailedError,
  StreamProtocolError,
  StreamRefusalBodyError,
  StreamReconnectsExhaustedError,
  StreamRetryDeferredError,
  consumeStream,
  consumeStreamCheckpointed,
  decodeStreamFrame,
  isEventStreamMediaType,
  parseSseFrame,
  streamFeed,
  streamFeedResilient,
} from "./stream.js";
export type {
  CheckpointedStreamHandlers,
  CheckpointedStreamOptions,
  FeedEnvelope,
  ParsedSseFrame,
  ResilientStreamOptions,
  ResyncMarker,
  StreamCheckpoint,
  StreamCheckpointReason,
  StreamEvent,
  StreamFilters,
  StreamHandlerFailure,
  StreamHandlerStage,
  StreamOptions,
  StreamProtocolErrorReason,
  StreamRefusalBodyErrorReason,
} from "./stream.js";

// Webhooks
export {
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
  TIMESTAMP_HEADER,
  WEBHOOK_EVENT_TYPES,
  computeSignature,
  parseWebhookEvent,
  verifySignature,
} from "./webhooks.js";
export type {
  InsiderRadarFlagRaisedData,
  InsiderRadarFlagRaisedEvent,
  ExportJobCancelledData,
  ExportJobCancelledEvent,
  ExportJobExpiredData,
  ExportJobExpiredEvent,
  ExportJobFailedData,
  ExportJobFailedEvent,
  ExportJobReadyData,
  ExportJobReadyEvent,
  LargePositionsUpdatedData,
  LargePositionsUpdatedEvent,
  LiveSportsScoreEntry,
  LiveSportsUpdatedData,
  LiveSportsUpdatedEvent,
  SharpMoneyFlowDetectedData,
  SharpMoneyFlowDetectedEvent,
  SmartMoneyFlowDetectedData,
  SmartMoneyFlowDetectedEvent,
  SuspiciousTradeFlaggedData,
  SuspiciousTradeFlaggedEvent,
  VerifySignatureInput,
  WalletGradeChangedData,
  WalletGradeChangedEvent,
  WebhookEvent,
  WebhookEventEnvelope,
  WhaleTradesInsertedData,
  WhaleTradesInsertedEvent,
  WhaleTraderSyncedData,
  WhaleTraderSyncedEvent,
} from "./webhooks.js";

// Which OpenAPI document this release was generated from (scripts/generate.mjs).
// Compare OPENAPI_SHA256 with the SHA-256 of the live document to see whether a
// release is behind the API.
export {
  APP_COMMIT,
  APP_REPOSITORY,
  APP_SPEC_PATH,
  OPENAPI_SHA256,
  OPENAPI_SOURCE,
  OPENAPI_VERSION,
  OPERATION_COUNT,
} from "./provenance.js";

// Generated contract types (scripts/generate-sdk-types.mjs, #14278). Every
// schema the public OpenAPI document declares, plus the per-operation maps
// (`OperationPath`, `OperationQuery`, `OperationBody`, `OperationData`,
// `OperationResponse`) the client's `call`, `list` and every convenience
// method are typed by (#16136). Regenerate rather than edit:
// `node scripts/generate-sdk-types.mjs`.
export type {
  AccountIdentity,
  ApiErrorBody,
  CategorySkillModelReadiness,
  CategorySkillV2,
  DataQuality,
  DataQualityGroup,
  ExactDecimal,
  GameCompetitor,
  GameCoverage,
  GameFreshness,
  GameMarket,
  GameMarketPriceBindingProvenance,
  GameMarketPriceCompetitor,
  GameMarketPriceIncomplete,
  GameMarketPriceInvalid,
  GameMarketPricePaired,
  GameMarketPrices,
  GameMarketProviderPrices,
  GameStatus,
  GamesCoverage,
  HolderCategoryEvidence,
  LargeTradeSubscriptionFilters,
  MarketHolder,
  MarketHoldersMarket,
  MarketHoldersScan,
  MarketHoldersSideGrades,
  MarketHoldersTotals,
  PickOfTheDayCommitmentPayloadV1,
  PickOfTheDayCommitmentPayloadV2,
  PositionExact,
  TraderPnlExact,
  TraderStatsExact,
  WebhookEventType,
  WebhookSecretRotation,
  WhaleDatasetArtifactManifest,
  WhaleDatasetContinuation,
  WhaleDatasetFilters,
  WhaleDatasetGeneration,
  WhaleDatasetJob,
  WhaleDatasetTrade,
  AgentRegistration,
  ApiDiscovery,
  ApiError,
  BatchMarketFlowItem,
  BatchRateLimitMeta,
  BatchResponseMeta,
  BatchTraderItem,
  Candle,
  ContentSearchResult,
  CounterpartyAnalysis,
  CounterpartyExecution,
  CounterpartyMakerPage,
  CounterpartyMatchBreakdown,
  CounterpartyParticipant,
  CreateWebhookRequest,
  EventReplayEvent,
  EventReplayFreshness,
  EventReplayMeta,
  EventReplaySource,
  ExploreEntry,
  ExploreFacetValue,
  ExploreFacets,
  ExploreGroup,
  ExploreMarket,
  ExploreStandalone,
  ExportCompleteness,
  ExportCounts,
  ExportSourceRange,
  ExportVolumeReconciliation,
  LargeExportPolicy,
  LargePosition,
  LeaderboardEntry,
  MarketCandles,
  MarketFlow,
  MarketSearchResult,
  MarketSnapshot,
  MarketSnapshotFreshness,
  MarketSnapshotTopOfBook,
  MarketSnapshotTrust,
  McpJsonRpcError,
  OutcomeCandles,
  PickHolder,
  PickLeadBacker,
  PickOfTheDay,
  PickOfTheDayNoEntitledPicks,
  PickOfTheDayArchive,
  PickOfTheDayArchiveDay,
  PickOfTheDayArchiveEntry,
  PickOfTheDayCommitmentPayload,
  PickOfTheDayHitRate,
  PickOfTheDayLedger,
  PickOfTheDayLedgerEntry,
  PickOfTheDayLedgerOpenedEntry,
  PickOfTheDayLedgerSealedEntry,
  PickOfTheDayLedgerUncommittedEntry,
  PickOfTheDayUncommittedPayload,
  PickSportsContext,
  PickSportsTeam,
  PlatformCapabilities,
  PlatformCapabilityStatus,
  Platforms,
  Position,
  PositionTimelineEvent,
  PotdEntryAuthorization,
  ProofPendingPickSlot,
  ReportPayload,
  ReportReconciliation,
  ReportSnapshot,
  ReportSourceRange,
  ResponseMeta,
  ScheduledPickSlot,
  ScoreCell,
  ScoreFormat,
  SmartMoneyFlowMarket,
  SnapshotCompleteness,
  SnapshotState,
  PreGameSideFunnelReport,
  PreGameSideObservation,
  PreGameSideObservationTerminalReason,
  PreGameSide,
  PreGameSideCategorySkill,
  PreGameSideSportFunnelReport,
  SuspiciousTrade,
  TennisPoints,
  TennisRanking,
  Trader,
  TraderCategoryRecord,
  TraderCategoryRecords,
  TraderGradeAt,
  TraderContext,
  TraderEsportsGameRecord,
  TraderExportJob,
  TraderExportArtifactManifest,
  TraderExportCategoryWatermark,
  TraderExportGeneration,
  TraderExportPnlWatermark,
  TraderExportPositionWatermark,
  TraderExportSnapshot,
  TraderExportSourceWatermarks,
  TraderExportTradeWatermark,
  TraderPnl,
  TraderTrust,
  TrendingWallet,
  TrustCompleteness,
  TrustFreshness,
  TrustMetadata,
  TrustReconciliation,
  TrustSource,
  UpdateWebhookRequest,
  Usage,
  VerifyWebhookRequest,
  CreateWebhookVerificationAttemptRequest,
  WebhookVerificationAttempt,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEventDescriptor,
  WebhookRetryPolicy,
  WebhookStatus,
  WebhookVerification,
  LargeTrade,
  LargeTradeDetail,
  LargeTradeHistoryMeta,
  OperationBody,
  OperationData,
  OperationPath,
  OperationQuery,
  OperationResponse,
} from "./schema.js";

/**
 * @deprecated Use `SuspiciousTrade`. The OpenAPI component schema `RadarFlag`
 * was renamed to `SuspiciousTrade` in #16301 and the generated types no longer
 * spell it, so the name is kept here as an alias: an existing
 * `import type { RadarFlag } from "@0xinsider/sdk"` keeps compiling and keeps
 * describing the same payload. The deprecated
 * `GET /api/v1/insider-radar/{id}` still returns it under
 * `object: "radar_flag"`.
 */
export type RadarFlag = import("./schema.js").SuspiciousTrade;
import type { LargeTrade, LargeTradeDetail, LargeTradeHistoryMeta } from "./schema.js";
import type { BatchMarketFlowItem, MarketFlow } from "./schema.js";
/** @deprecated Use {@link MarketFlow} (#16312). */
export type MarketIntel = MarketFlow;
/** @deprecated Use {@link BatchMarketFlowItem} (#16312). */
export type BatchMarketIntelItem = BatchMarketFlowItem;
/** @deprecated Use {@link LargeTrade} (#16304). */
export type WhaleTrade = LargeTrade;
/** @deprecated Use {@link LargeTradeDetail} (#16304). */
export type WhaleTradeDetail = LargeTradeDetail;
/** @deprecated Use {@link LargeTradeHistoryMeta} (#16304). */
export type WhaleTradeHistoryMeta = LargeTradeHistoryMeta;
import type {
  PreGameSide,
  PreGameSideCategorySkill,
  PreGameSideFunnelReport,
  PreGameSideObservation,
  PreGameSideObservationTerminalReason,
  PreGameSideSportFunnelReport,
} from "./schema.js";
/** @deprecated Use {@link PreGameSide} (#16310). */
export type SportsEdgeSignal = PreGameSide;
/** @deprecated Use {@link PreGameSideCategorySkill} (#16310). */
export type SportsEdgeSignalCategorySkill = PreGameSideCategorySkill;
/** @deprecated Use {@link PreGameSideObservation} (#16310). */
export type SportsEdgeObservation = PreGameSideObservation;
/** @deprecated Use {@link PreGameSideObservationTerminalReason} (#16310). */
export type SportsEdgeObservationTerminalReason = PreGameSideObservationTerminalReason;
/** @deprecated Use {@link PreGameSideFunnelReport} (#16310). */
export type SportsEdgeFunnelReport = PreGameSideFunnelReport;
/** @deprecated Use {@link PreGameSideSportFunnelReport} (#16310). */
export type SportsEdgeSportFunnelReport = PreGameSideSportFunnelReport;
