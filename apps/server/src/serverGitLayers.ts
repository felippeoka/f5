import { Layer } from "effect";

import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { CheckpointStoreLiveWithGitService } from "./checkpointing/Layers/CheckpointStore.ts";
import { GitCoreLive } from "./git/Layers/GitCore.ts";
import { GitServiceLive } from "./git/Layers/GitService.ts";

// Both consumers must receive the configured service. Layer memoization otherwise
// lets checkpointing create GitServiceLive without secrets before GitCore needs it.
export const ServerGitLive = Layer.mergeAll(CheckpointStoreLiveWithGitService, GitCoreLive).pipe(
  Layer.provideMerge(GitServiceLive.pipe(Layer.provideMerge(ServerSecretStoreLive))),
);
