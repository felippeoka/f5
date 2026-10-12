import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { expect, it, vi } from "vitest";

import { ServerSecretStore } from "./auth/Services/ServerSecretStore.ts";
import { CheckpointStore } from "./checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "./config.ts";
import * as ProfileGitEnvironment from "./git/profileGitEnvironment.ts";
import { GitCore } from "./git/Services/GitCore.ts";
import { GitService } from "./git/Services/GitService.ts";
import { ServerGitLive } from "./serverGitLayers.ts";

it("keeps profile credentials available when checkpointing initializes Git first", async () => {
  const credentials: Array<string | null> = [];
  const environment = vi
    .spyOn(ProfileGitEnvironment, "profileGitEnvironment")
    .mockImplementation(async (input) => {
      credentials.push(await input.tokenForHost("github.com"));
      return { ...process.env, ...input.overrides };
    });
  const layer = ServerGitLive.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "f5-server-git-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const config = yield* ServerConfig;
        const secrets = yield* ServerSecretStore;
        const checkpoints = yield* CheckpointStore;
        const git = yield* GitService;
        const core = yield* GitCore;
        const cwd = config.stateDir;

        yield* git.execute({ operation: "test.init", cwd, args: ["init"] });
        expect(credentials.at(-1)).toBeNull();

        for (const token of ["initial-profile-token", "reconnected-profile-token"]) {
          yield* secrets.set("github-token-github.com", new TextEncoder().encode(token));
          yield* core.initRepo({ cwd });
          expect(credentials.at(-1)).toBe(token);
          expect(yield* checkpoints.isGitRepository(cwd)).toBe(true);
          expect(credentials.at(-1)).toBe(token);
        }
      }).pipe(Effect.provide(layer)),
    );
  } finally {
    environment.mockRestore();
  }
});
