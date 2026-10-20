import type { ReportClientDiagnosticsInput } from "@t3tools/contracts";
import { Effect, Metric } from "effect";

const counterNames = [
  "snapshotSyncs",
  "gapRecoveries",
  "bufferOverflows",
  "poisonBatches",
  "connectedMs",
] as const;
const metrics = Object.fromEntries(
  counterNames.map((name) => [name, Metric.counter(`f5_client_${name}_total`)]),
) as Record<(typeof counterNames)[number], Metric.Metric<number, unknown>>;
const buckets = Metric.counter("f5_client_apply_batch_bucket_total");
const bounds = ["1", "2", "4", "8", "16", "32", "64", "128", "+Inf"];
const delta = (current: number, previous = 0) =>
  current >= previous ? current - previous : current;

/** Page/session identifiers never enter metric labels. */
export function makeClientDiagnosticsReporter() {
  const sessions = new Map<string, ReportClientDiagnosticsInput>();
  const accept = (report: ReportClientDiagnosticsInput) => {
    const previous = sessions.get(report.sessionId);
    if (previous && report.reportSeq <= previous.reportSeq) return null;
    sessions.delete(report.sessionId);
    sessions.set(report.sessionId, report);
    if (sessions.size > 256) sessions.delete(sessions.keys().next().value!);
    const base = previous?.clientKind === report.clientKind ? previous : undefined;
    return {
      counters: Object.fromEntries(
        counterNames.map((name) => [name, delta(report.counters[name], base?.counters[name])]),
      ) as Record<(typeof counterNames)[number], number>,
      buckets: report.applyBatchBuckets.map((count, index) =>
        delta(count, base?.applyBatchBuckets[index]),
      ),
    };
  };
  return {
    accept,
    get size() {
      return sessions.size;
    },
    report: (report: ReportClientDiagnosticsInput) =>
      Effect.suspend(() => {
        const changes = accept(report);
        if (!changes) return Effect.void;
        return Effect.gen(function* () {
          for (const name of counterNames)
            yield* Metric.update(
              Metric.withAttributes(metrics[name], { clientKind: report.clientKind }),
              changes.counters[name],
            );
          let cumulative = 0;
          for (let index = 0; index < bounds.length; index++) {
            cumulative += changes.buckets[index]!;
            yield* Metric.update(
              Metric.withAttributes(buckets, { clientKind: report.clientKind, le: bounds[index]! }),
              cumulative,
            );
          }
        });
      }),
  };
}
