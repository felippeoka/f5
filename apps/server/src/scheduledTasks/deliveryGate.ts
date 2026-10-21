import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSettingsService } from "../serverSettings.ts";
import { ProviderTurnDeliveryError } from "../provider/Errors.ts";
import { scheduledSendGate } from "./sendGate.ts";
/** The provider has not received a send here, so a closed gate is provably not-sent. */
export const assertScheduledDeliveryAllowed = (commandId: string | undefined) =>
  Effect.gen(function* () {
    if (!commandId) return;
    const sql = yield* SqlClient.SqlClient,
      settings = yield* (yield* ServerSettingsService).getSettings;
    const gate = yield* scheduledSendGate(sql, settings, commandId);
    if (gate !== "ready")
      return yield* new ProviderTurnDeliveryError({
        certainty: "not_sent",
        retryable: gate === "wait",
        detail: "Scheduled execution is fenced or waiting for authorization/capacity.",
      });
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(ProviderTurnDeliveryError)(error)
        ? error
        : new ProviderTurnDeliveryError({
            certainty: "not_sent",
            retryable: true,
            detail: "Scheduled authorization could not be verified.",
            cause: error,
          }),
    ),
  );
