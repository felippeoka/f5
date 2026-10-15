import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { writeAcpWrapper } from "../../testUtils/cli.ts";
import { openMspHost } from "./MspSessionRuntime.ts";
import { makeMspTransport } from "./MspTransport.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockHostPath = path.join(__dirname, "../../../scripts/msp-mock-host.ts");

const wrapper = (env: Record<string, string>) =>
  Effect.promise(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "msp-mock-host-"));
    return writeAcpWrapper(path.join(dir, "fake-muse"), mockHostPath, { env });
  });

it.layer(NodeServices.layer)("MspTransport", (it) => {
  it.effect(
    "speaks MSP to a spawned host and keeps the stderr tail",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* wrapper({ MSP_MOCK_STDERR: "booting muse\n" });
        const handle = yield* makeMspTransport({
          binaryPath,
          args: ["serve"],
          cwd: process.cwd(),
          environment: process.env,
        });
        const host = yield* Effect.promise(() =>
          openMspHost({ transport: handle.transport, clientVersion: "test" }),
        );
        assert.equal(host.initializeResult.serverInfo.name, "muse-mock");
        const models = yield* Effect.promise(() => host.request("model/list", {}));
        assert.ok(Array.isArray(models.models));
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)));
        assert.include(handle.stderrTail(), "booting muse");
        yield* Effect.promise(() => host.close());
        const exit = yield* Effect.promise(() => handle.exited);
        assert.equal(exit.code, 0);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect(
    "escalates to SIGKILL when the host ignores stdin EOF and SIGTERM",
    () =>
      Effect.gen(function* () {
        const binaryPath = yield* wrapper({
          MSP_MOCK_STAY_ALIVE: "1",
          MSP_MOCK_IGNORE_SIGTERM: "1",
        });
        const handle = yield* makeMspTransport({
          binaryPath,
          args: ["serve"],
          cwd: process.cwd(),
          environment: process.env,
          timings: { flushBudgetMs: 50, termAfterMs: 100, killAfterMs: 200 },
        });
        yield* Effect.promise(() =>
          openMspHost({ transport: handle.transport, clientVersion: "test" }),
        );
        const startedAt = Date.now();
        yield* Effect.promise(async () => handle.transport.close?.());
        const exit = yield* Effect.promise(() => handle.exited);
        // Windows has no SIGTERM to ignore: the first signal already terminates.
        if (process.platform !== "win32") assert.isAtLeast(Date.now() - startedAt, 250);
        assert.notEqual(exit.code, 0);
        yield* Effect.promise(async () => {
          await handle.transport.write("{}\n").then(
            () => assert.fail("write after close must fail"),
            (error: Error) => assert.match(error.message, /closed/),
          );
        });
      }).pipe(Effect.scoped),
    30_000,
  );
});
