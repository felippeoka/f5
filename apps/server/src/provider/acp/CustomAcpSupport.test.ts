import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChildProcessSpawner } from "effect/unstable/process";
import { AcpSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { writeAcpWrapper, writeCliScript, waitForAgentExit } from "../../testUtils/cli.ts";
import { customAcpModels, makeCustomAcpRuntime } from "./CustomAcpSupport.ts";
import { probeCustomAcp, checkCustomAcpProvider } from "../Layers/CustomAcpProvider.ts";
const run = <A, E>(
  work: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | import("effect").FileSystem.FileSystem
  >,
) => Effect.runPromise(work.pipe(Effect.provide(NodeServices.layer)));
async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "f5-custom-acp-"));
  const log = path.join(cwd, "requests.jsonl"),
    exitLog = path.join(cwd, "exit"),
    argv = path.join(cwd, "argv");
  const command = writeAcpWrapper(
    path.join(cwd, "agent with spaces"),
    path.resolve("scripts/acp-mock-agent.ts"),
    {
      argvLogPath: argv,
      env: { T3_ACP_REQUEST_LOG_PATH: log, T3_ACP_EXIT_LOG_PATH: exitLog, ACP_MOCK_AUTH_FAIL: "1" },
    },
  );
  const config = Schema.decodeUnknownSync(AcpSettings)({
    command,
    args: ["--acp", "one argument with spaces", "$(echo unexpanded)"],
  });
  return { cwd, log, exitLog, argv, config };
}
describe("custom local ACP", () => {
  it("initializes only during health checks and closes its process", async () => {
    const f = await fixture();
    try {
      expect((await run(probeCustomAcp(f.config, process.env))).protocolVersion).toBe(1);
      const requests = (await readFile(f.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.map((r) => r.method)).toEqual(["initialize"]);
      expect(requests[0].params.clientCapabilities).toEqual({});
      expect(await readFile(f.argv, "utf8")).toBe(f.config.args.join("\t") + "\t\n");
      await waitForAgentExit(f.exitLog);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });
  it("starts a session without selecting authentication and reads native session model choices", async () => {
    const f = await fixture();
    try {
      await run(
        Effect.scoped(
          Effect.gen(function* () {
            const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            const runtime = yield* makeCustomAcpRuntime(f.config, {
              childProcessSpawner,
              grokSettings: null,
              cwd: f.cwd,
              environment: process.env,
              clientInfo: { name: "test", version: "1" },
            });
            yield* runtime.start();
            const choices = customAcpModels(yield* runtime.getConfigOptions);
            expect(choices.map((choice) => choice.slug)).toContain("gpt-5.4");
            yield* runtime.setSessionModel("gpt-5.4");
          }),
        ),
      );
      const requests = (await readFile(f.log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(requests.some((r) => r.method === "authenticate")).toBe(false);
      expect(requests.some((r) => r.method === "session/new")).toBe(true);
      expect(requests.some((r) => r.method === "session/set_config_option")).toBe(true);
      await waitForAgentExit(f.exitLog);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });
  it("never launches a disabled agent", async () => {
    const config = Schema.decodeUnknownSync(AcpSettings)({ command: "/unavailable/agent" });
    const result = await run(checkCustomAcpProvider(config, {}, false, []));
    expect(result.status).toBe("disabled");
    expect(result.installed).toBe(false);
  });
  it("terminates a silent initialization at the ten-second deadline", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "f5-acp-probe-timeout-"));
    const log = path.join(cwd, "exit");
    try {
      const command = writeCliScript(
        path.join(cwd, "silent"),
        `require("node:fs").writeFileSync(${JSON.stringify(log + ".pids")}, String(process.pid) + "\\n"); process.stdin.resume();`,
      );
      const config = Schema.decodeUnknownSync(AcpSettings)({ command });
      const result = await run(probeCustomAcp(config, process.env).pipe(Effect.result));
      expect(result._tag).toBe("Failure");
      await waitForAgentExit(log);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 20000);
});
