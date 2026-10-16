import { CommandId, type ProjectId } from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Ref,
  Schedule,
  Scope,
  Stream,
} from "effect";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectSkillSyncService,
  type ProjectSkillSyncServiceShape,
} from "../Services/ProjectSkillSyncService.ts";
import {
  buildProjectSkillFingerprint,
  scanProjectSkills,
  type ProjectSkillScanWarning,
} from "../projectSkills.ts";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const startedRef = yield* Ref.make(false);
  const started = yield* Deferred.make<void>();
  const dirty = new Set<ProjectId>();
  const pathsByProject = new Map<ProjectId, ReadonlyArray<string>>();
  const warnings = new Map<ProjectId, ReadonlyArray<ProjectSkillScanWarning>>();
  const watchers = new Map<string, { scope: Scope.Closeable; projects: Set<ProjectId> }>();
  const failedWatchPaths = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let worker!: DrainableWorker<void>;

  const queueRefresh = (ids: Iterable<ProjectId>) =>
    Effect.sync(() => {
      for (const id of ids) dirty.add(id);
      if (timer !== undefined || dirty.size === 0) return;
      timer = setTimeout(() => {
        timer = undefined;
        void Effect.runPromise(worker.enqueue(undefined));
      }, 150);
      timer.unref?.();
    });

  const reconcileWatchers = Effect.gen(function* () {
    const desired = new Map<string, Set<ProjectId>>();
    for (const [id, paths] of pathsByProject) {
      for (const path of paths) {
        const projects = desired.get(path) ?? new Set<ProjectId>();
        projects.add(id);
        desired.set(path, projects);
      }
    }
    for (const [path, watcher] of watchers) {
      if (!desired.has(path) || failedWatchPaths.has(path)) {
        yield* Scope.close(watcher.scope, Exit.void);
        watchers.delete(path);
      }
    }
    for (const [path, projects] of desired) {
      const existing = watchers.get(path);
      if (existing) {
        existing.projects = projects;
        continue;
      }
      const watcherScope = yield* Scope.make("sequential");
      watchers.set(path, { scope: watcherScope, projects });
      failedWatchPaths.delete(path);
      yield* Stream.runForEach(fs.watch(path), () =>
        queueRefresh(watchers.get(path)?.projects ?? []),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (Cause.hasInterruptsOnly(cause)) return;
            failedWatchPaths.add(path);
            for (const id of watchers.get(path)?.projects ?? []) {
              warnings.set(id, [
                ...(warnings.get(id) ?? []),
                {
                  scope: "project",
                  commandName: "",
                  path,
                  reason: `Skill watcher unavailable; polling will retry: ${String(cause)}`,
                },
              ]);
            }
          }),
        ),
        Effect.forkIn(watcherScope),
      );
    }
  });

  const refresh = Effect.gen(function* () {
    const ids = new Set(dirty);
    dirty.clear();
    const model = yield* engine.getReadModel();
    const active = new Set(
      model.projects.filter((project) => project.deletedAt === null).map((project) => project.id),
    );
    for (const id of pathsByProject.keys()) {
      if (!active.has(id)) {
        pathsByProject.delete(id);
        warnings.delete(id);
      }
    }
    for (const project of model.projects) {
      if (!active.has(project.id) || !ids.has(project.id)) continue;
      const result = yield* scanProjectSkills({
        projectId: project.id,
        workspaceRoot: project.workspaceRoot,
      });
      pathsByProject.set(project.id, result.watchPaths);
      warnings.set(project.id, result.warnings);
      if (
        buildProjectSkillFingerprint(project.skills ?? []) !==
        buildProjectSkillFingerprint(result.skills)
      ) {
        yield* engine.dispatch({
          type: "project.skills.replace",
          commandId: CommandId.makeUnsafe(`project-skills:${crypto.randomUUID()}`),
          projectId: project.id,
          skills: [...result.skills],
          updatedAt: new Date().toISOString(),
        });
      }
    }
    yield* reconcileWatchers;
  });

  worker = yield* makeDrainableWorker(() =>
    refresh.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("project skill refresh failed", { cause: String(cause) }),
      ),
    ),
  );

  const drain = Effect.gen(function* () {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (dirty.size > 0) yield* worker.enqueue(undefined);
    yield* worker.drain;
  });

  const start: ProjectSkillSyncServiceShape["start"] = Ref.getAndSet(startedRef, true).pipe(
    Effect.flatMap((alreadyStarted) =>
      alreadyStarted
        ? Deferred.await(started)
        : Effect.gen(function* () {
            yield* Stream.runForEach(engine.streamDomainEvents, (event) =>
              event.type === "project.created" ||
              event.type === "project.meta-updated" ||
              event.type === "project.deleted"
                ? queueRefresh([event.aggregateId as ProjectId])
                : Effect.void,
            ).pipe(Effect.forkIn(scope));
            for (const project of (yield* engine.getReadModel()).projects) dirty.add(project.id);
            yield* drain;
            // Watch failures/deleted roots recover even if the OS emits no final event.
            yield* Effect.sync(
              () =>
                new Set(
                  [...failedWatchPaths].flatMap((path) => [
                    ...(watchers.get(path)?.projects ?? []),
                  ]),
                ),
            ).pipe(
              Effect.flatMap(queueRefresh),
              Effect.repeat(Schedule.spaced("30 seconds")),
              Effect.forkIn(scope),
            );
            yield* Deferred.succeed(started, undefined);
          }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (timer !== undefined) clearTimeout(timer);
      for (const watcher of watchers.values()) yield* Scope.close(watcher.scope, Exit.void);
      watchers.clear();
    }),
  );

  return {
    start,
    drain,
    getWarnings: (projectId) => Effect.sync(() => warnings.get(projectId) ?? []),
  } satisfies ProjectSkillSyncServiceShape;
});

export const ProjectSkillSyncServiceLive = Layer.effect(ProjectSkillSyncService, make);
