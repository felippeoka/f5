import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Schema } from "effect";
import { ScheduledTaskCreateInput } from "@t3tools/contracts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { FakeAgentBridgeHost, project } from "../agentBridge/testing/fakeHost.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeScheduledTaskStore } from "./Store.ts";
import { makeScheduledTaskService, userScheduleActor as actor } from "./Service.ts";
const layer = SqlitePersistenceMemory.pipe(Layer.provideMerge(NodeServices.layer));
export const setup = Effect.gen(function* () {
  const store = yield* makeScheduledTaskStore,
    host = new FakeAgentBridgeHost();
  host.projects = [project("project")];
  const settings = yield* ServerSettingsService;
  const service = yield* makeScheduledTaskService({
    store,
    host: host.shape,
    settings,
    publish: () => Effect.void,
  });
  const create = (extra = {}) =>
    service.create(
      Schema.decodeUnknownSync(ScheduledTaskCreateInput)({
        id: crypto.randomUUID(),
        projectId: "project",
        requestedAt: new Date(0).toISOString(),
        configuration: {
          name: "Check",
          prompt: "Check tests",
          modelSelection: { instanceId: "codex", model: "model-a" },
          runtimeMode: "approval-required",
          workspace: { kind: "projectRoot" },
          cron: "* * * * *",
          timezone: "UTC",
          scheduleSource: "cron",
          maxRuns: null,
          oneShotAt: null,
          notify: "all",
          enabled: true,
          ...extra,
        },
      }),
      actor,
    );
  return { store, host, settings, service, create };
});
export const testLayer = Layer.merge(layer, ServerSettingsService.layerTest());
