import {
  CommandId,
  OrchestrationUsageLimit,
  MessageId,
  NonNegativeInt,
  OrchestrationEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export const ProviderTurnDeliveryState = Schema.Literals([
  "pending",
  "sending",
  "accepted",
  "rejected",
  "ambiguous",
  "abandoned",
]);
export type ProviderTurnDeliveryState = typeof ProviderTurnDeliveryState.Type;

export const DeliveryHistoryEvidence = Schema.Struct({
  sessionOrigin: Schema.optional(Schema.Literals(["fresh", "resumed", "unknown"])),
  identity: Schema.NullOr(Schema.String),
  provenance: Schema.Literals(["provider-persisted", "runtime-local", "unavailable"]),
  coverage: Schema.Literals(["complete", "partial", "unavailable"]),
  boundary: Schema.NullOr(Schema.String),
  runtimeId: Schema.NullOr(Schema.String),
});

export const DeliveryAcceptanceReceipt = Schema.Struct({
  turnId: TurnId,
  attemptId: Schema.String,
  runtimeGeneration: Schema.Number,
  nativeHistoryIdentity: Schema.NullOr(Schema.String),
  acceptedAt: Schema.String,
});

export const ProviderTurnDelivery = Schema.Struct({
  deliveryId: CommandId,
  threadId: ThreadId,
  commandId: CommandId,
  messageId: MessageId,
  state: ProviderTurnDeliveryState,
  providerTurnId: Schema.NullOr(TurnId),
  attempt: NonNegativeInt,
  preSendTurnIds: Schema.Array(TurnId),
  acceptanceReceipt: Schema.optional(Schema.NullOr(DeliveryAcceptanceReceipt)),
  attemptId: Schema.optional(Schema.NullOr(Schema.String)),
  historyEvidence: Schema.optional(Schema.NullOr(DeliveryHistoryEvidence)),
  event: OrchestrationEvent,
  errorCode: Schema.NullOr(Schema.String),
  errorDetail: Schema.NullOr(Schema.String),
  usageLimit: Schema.optional(Schema.NullOr(OrchestrationUsageLimit)),
  certainty: Schema.NullOr(Schema.Literals(["not_sent", "unknown"])),
  notBefore: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  outcomeProjectedAt: Schema.NullOr(Schema.String),
});
export type ProviderTurnDelivery = typeof ProviderTurnDelivery.Type;

export type ProviderTurnDeliveryRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface ProviderTurnDeliveryRepositoryShape {
  readonly listCandidateIds: (input: {
    readonly afterThreadId: string;
    readonly limit: number;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly deliveryId: CommandId; readonly threadId: ThreadId }>,
    ProviderTurnDeliveryRepositoryError
  >;
  readonly listActionable: Effect.Effect<
    ReadonlyArray<ProviderTurnDelivery>,
    ProviderTurnDeliveryRepositoryError
  >;
  readonly listSending: Effect.Effect<
    ReadonlyArray<ProviderTurnDelivery>,
    ProviderTurnDeliveryRepositoryError
  >;
  readonly listUnprojectedTerminal: Effect.Effect<
    ReadonlyArray<ProviderTurnDelivery>,
    ProviderTurnDeliveryRepositoryError
  >;
  readonly getByCommandId: (
    commandId: CommandId,
  ) => Effect.Effect<ProviderTurnDelivery | null, ProviderTurnDeliveryRepositoryError>;
  readonly getLatestByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderTurnDelivery | null, ProviderTurnDeliveryRepositoryError>;
  readonly getUnresolvedByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderTurnDelivery | null, ProviderTurnDeliveryRepositoryError>;
  /** Provider turns already attributed to accepted deliveries on this thread. */
  readonly listAcceptedTurnIdsByThread: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<TurnId>, ProviderTurnDeliveryRepositoryError>;
  /**
   * The pre-send turn snapshot of the earliest newer delivery on the same
   * thread that has been claimed. Turns outside it may belong to that newer
   * send. Null when no newer delivery has been claimed.
   */
  readonly getSupersedingPreSendTurnIds: (
    deliveryId: CommandId,
  ) => Effect.Effect<ReadonlyArray<TurnId> | null, ProviderTurnDeliveryRepositoryError>;
  readonly recordDispatchIntent: (input: {
    readonly deliveryId: CommandId;
    readonly attemptId: string;
    readonly preSendTurnIds: ReadonlyArray<TurnId>;
    readonly historyEvidence: typeof DeliveryHistoryEvidence.Type | null;
  }) => Effect.Effect<boolean, ProviderTurnDeliveryRepositoryError>;
  readonly claim: (
    deliveryId: CommandId,
    preSendTurnIds: ReadonlyArray<TurnId>,
    historyEvidence?: typeof DeliveryHistoryEvidence.Type | null,
  ) => Effect.Effect<ProviderTurnDelivery | null, ProviderTurnDeliveryRepositoryError>;
  readonly markAccepted: (input: {
    readonly deliveryId: CommandId;
    readonly providerTurnId: TurnId;
    readonly receipt?: typeof DeliveryAcceptanceReceipt.Type | undefined;
    readonly attemptId?: string | null | undefined;
  }) => Effect.Effect<boolean, ProviderTurnDeliveryRepositoryError>;
  readonly markRejected: (input: {
    readonly deliveryId: CommandId;
    readonly attemptId?: string | null | undefined;
    readonly errorCode: string;
    readonly errorDetail: string;
    readonly certainty: "not_sent" | "unknown";
    readonly ambiguous: boolean;
    readonly occurredAt?: string | undefined;
    readonly usageLimit?: OrchestrationUsageLimit | undefined;
  }) => Effect.Effect<boolean, ProviderTurnDeliveryRepositoryError>;
  readonly requeue: (input: {
    readonly deliveryId: CommandId;
    readonly notBefore: string;
    readonly errorCode: string;
    readonly errorDetail: string;
  }) => Effect.Effect<void, ProviderTurnDeliveryRepositoryError>;
  readonly retryTerminal: (input: {
    readonly deliveryId: CommandId;
    readonly allowPossibleDuplicate: boolean;
  }) => Effect.Effect<ProviderTurnDelivery | null, ProviderTurnDeliveryRepositoryError>;
  /** Returns false when the delivery was no longer rejected or ambiguous. */
  readonly markAbandoned: (
    deliveryId: CommandId,
  ) => Effect.Effect<boolean, ProviderTurnDeliveryRepositoryError>;
  readonly markOutcomeProjected: (
    deliveryId: CommandId,
  ) => Effect.Effect<void, ProviderTurnDeliveryRepositoryError>;
}

export class ProviderTurnDeliveryRepository extends ServiceMap.Service<
  ProviderTurnDeliveryRepository,
  ProviderTurnDeliveryRepositoryShape
>()("t3/orchestration/Services/ProviderTurnDeliveryRepository") {}
