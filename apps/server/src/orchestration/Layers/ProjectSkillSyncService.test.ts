import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, ManagedRuntime, PubSub, Scope, Stream, Exit } from "effect";
import {
  ProjectId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationProject,
} from "@t3tools/contracts";
import { expect, it, vi } from "vitest";
import { ProjectSkillSyncServiceLive } from "./ProjectSkillSyncService.ts";
import { ProjectSkillSyncService } from "../Services/ProjectSkillSyncService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import * as scanner from "../projectSkills.ts";

it("refreshes only dirty projects, keeps unchanged watchers, and exposes parse diagnostics", async () => {
  const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "f5-skills-incremental-"));
  const roots = [Path.join(directory, "one"), Path.join(directory, "two")];
  for (const root of roots) {
    await FS.mkdir(Path.join(root, ".claude", "skills", "demo"), { recursive: true });
    await FS.writeFile(
      Path.join(root, ".claude", "skills", "demo", "SKILL.md"),
      "---\nname: Demo\ndescription: Test\n---\nInstructions.",
    );
  }
  const projects = roots.map((root, i) => ({
    id: ProjectId.makeUnsafe(`project-${i}`),
    title: `Project ${i}`,
    workspaceRoot: root,
    deletedAt: null,
    skills: [],
  })) as unknown as OrchestrationProject[];
  const events = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  const scan = vi.spyOn(scanner, "scanProjectSkills");
  let registrations = 0;
  const services = NodeServices.layer;
  const runtime = ManagedRuntime.make(
    ProjectSkillSyncServiceLive.pipe(
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          getReadModel: () => Effect.succeed({ projects } as unknown as OrchestrationReadModel),
          dispatch: (command: import("@t3tools/contracts").OrchestrationCommand) =>
            Effect.sync(() => {
              if (command.type === "project.skills.replace") {
                const project = projects.find((project) => project.id === command.projectId)!;
                projects[projects.indexOf(project)] = { ...project, skills: command.skills };
              }
              return { sequence: 1 };
            }),
          streamDomainEvents: Stream.fromPubSub(events),
        } as unknown as import("../Services/OrchestrationEngine.ts").OrchestrationEngineShape),
      ),
      Layer.provide(
        Layer.effect(
          FileSystem.FileSystem,
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return {
              ...fs,
              watch: (path: string) => {
                registrations++;
                return fs.watch(path);
              },
            } satisfies FileSystem.FileSystem;
          }),
        ).pipe(Layer.provide(services)),
      ),
      Layer.provide(services),
    ),
  );
  const scope = await Effect.runPromise(Scope.make("sequential"));
  try {
    const service = await runtime.runPromise(Effect.service(ProjectSkillSyncService));
    await runtime.runPromise(service.start.pipe(Scope.provide(scope)));
    await serviceDrain();
    const baseline = registrations;
    scan.mockClear();
    Effect.runSync(
      PubSub.publish(events, {
        type: "project.meta-updated",
        aggregateId: projects[0]!.id,
      } as OrchestrationEvent),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await serviceDrain();
    expect(scan.mock.calls.every(([input]) => input.projectId === projects[0]!.id)).toBe(true);
    expect(scan).toHaveBeenCalled();
    expect(registrations).toBe(baseline);
    scan.mockClear();
    await FS.writeFile(
      Path.join(roots[0]!, ".claude", "skills", "demo", "SKILL.md"),
      "---\nname: [unterminated\n---\nBroken",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await serviceDrain();
    expect((await runtime.runPromise(service.getWarnings(projects[0]!.id)))[0]).toMatchObject({
      path: expect.stringContaining("SKILL.md"),
      reason: expect.any(String),
    });
    expect(scan.mock.calls.every(([input]) => input.projectId === projects[0]!.id)).toBe(true);
    await FS.rm(Path.join(roots[0]!, ".claude"), { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await serviceDrain();
    expect(projects[0]?.skills).toEqual([]);
    await FS.mkdir(Path.join(roots[0]!, ".claude", "skills", "restored"), { recursive: true });
    await FS.writeFile(
      Path.join(roots[0]!, ".claude", "skills", "restored", "SKILL.md"),
      "---\nname: Restored\ndescription: Restored\n---\nInstructions.",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await serviceDrain();
    expect(projects[0]?.skills?.map((skill) => skill.commandName)).toContain("restored");

    async function serviceDrain() {
      await runtime.runPromise(service.drain);
    }
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await runtime.dispose();
    scan.mockRestore();
    await FS.rm(directory, { recursive: true, force: true });
  }
});
