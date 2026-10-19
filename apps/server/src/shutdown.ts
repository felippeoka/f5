import { Duration, Effect, Layer, Metric, Option, ServiceMap } from "effect";
import { createLogger } from "./logger.ts";

type Phase = "admission" | "flush" | "producers" | "drain" | "logs";
interface ShutdownStep {
  readonly name: string;
  readonly phase: Phase;
  readonly run: (deadline: number, signal: AbortSignal) => Promise<unknown>;
}
export interface ShutdownResult {
  readonly name: string;
  readonly phase: Phase;
  readonly outcome: "complete" | "failed" | "incomplete";
  readonly durationMs: number;
}
const phases: Phase[] = ["admission", "flush", "producers", "drain", "logs"];
const duration = Metric.timer("f5_shutdown_phase_duration");
const incomplete = Metric.counter("f5_shutdown_incomplete_total");
const logger = createLogger("shutdown");

export class ShutdownRegistry {
  private readonly steps = new Set<ShutdownStep>();
  private running: Promise<ReadonlyArray<ShutdownResult>> | undefined;
  deadline: number | undefined;
  get started() {
    return this.running !== undefined;
  }
  register(step: ShutdownStep) {
    if (this.started) throw new Error("Shutdown registration after admission closed");
    this.steps.add(step);
    return () => {
      this.steps.delete(step);
    };
  }
  run(): Promise<ReadonlyArray<ShutdownResult>> {
    if (this.running) return this.running;
    this.deadline = Date.now() + 1_800;
    this.running = this.finish(this.deadline);
    return this.running;
  }
  private async finish(deadline: number): Promise<ReadonlyArray<ShutdownResult>> {
    const results: ShutdownResult[] = [];
    for (const phase of phases) {
      await Promise.all(
        [...this.steps]
          .filter((step) => step.phase === phase)
          .map(async (step) => {
            const started = performance.now();
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let outcome: ShutdownResult["outcome"] = "complete";
            try {
              await Promise.race([
                Promise.resolve().then(() => step.run(deadline, controller.signal)),
                new Promise<void>((resolve) => {
                  timer = setTimeout(
                    () => {
                      outcome = "incomplete";
                      controller.abort();
                      resolve();
                    },
                    Math.max(0, deadline - Date.now()),
                  );
                }),
              ]);
            } catch (error) {
              if (!controller.signal.aborted) outcome = "failed";
              logger.warn("shutdown component did not finish", {
                phase,
                component: step.name,
                outcome,
                error: String(error),
              });
            } finally {
              if (timer) clearTimeout(timer);
            }
            const durationMs = performance.now() - started;
            const attributes = { phase, component: step.name };
            Effect.runSync(
              Metric.update(
                Metric.withAttributes(duration, attributes),
                Duration.millis(durationMs),
              ),
            );
            if (outcome !== "complete") {
              Effect.runSync(Metric.update(Metric.withAttributes(incomplete, attributes), 1));
              logger.warn("shutdown work incomplete", { phase, component: step.name, outcome });
            }
            results.push({ name: step.name, phase, outcome, durationMs });
          }),
      );
    }
    this.steps.clear();
    return results;
  }
}
export class ServerShutdown extends ServiceMap.Service<ServerShutdown, ShutdownRegistry>()(
  "t3/shutdown/ServerShutdown",
) {}
export const ServerShutdownLive = Layer.sync(ServerShutdown, () => new ShutdownRegistry());

/** Optional for isolated services/tests; the production server provides one registry. */
export const registerShutdown = <E, R>(
  name: string,
  phase: Phase,
  work: (deadline: number) => Effect.Effect<unknown, E, R>,
) =>
  Effect.gen(function* () {
    const coordinator = yield* Effect.serviceOption(ServerShutdown);
    if (Option.isNone(coordinator)) return;
    const services = yield* Effect.services<R>();
    const unregister = coordinator.value.register({
      name,
      phase,
      run: (deadline, signal) => Effect.runPromiseWith(services)(work(deadline), { signal }),
    });
    yield* Effect.addFinalizer(() => Effect.sync(unregister));
  });
