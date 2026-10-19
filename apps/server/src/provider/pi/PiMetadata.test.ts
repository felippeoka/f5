import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, type Layer } from "effect";
import { expect, it } from "vitest";
import { writeCliScript } from "../../testUtils/cli.ts";
import { probePiCatalog, type PiLaunchSettings } from "./PiMetadata.ts";
import { makePiTextGeneration, runPiMetadataPrompt } from "../../git/Layers/PiTextGeneration.ts";
import { PiRpcError } from "./PiRpc.ts";

const source = String.raw`
const fs=require('node:fs');
const trace=entry=>fs.appendFileSync(process.env.F5_PI_TRACE,JSON.stringify(entry)+'\n');
trace({type:'spawn',args:process.argv.slice(2),cwd:process.cwd(),pid:process.pid,privateEnvironment:!!process.env.F5_PI_MCP_BEARER_TOKEN});
const emit=record=>process.stdout.write(JSON.stringify(record)+'\n');
const reply=(record,data)=>emit({type:'response',id:record.id,command:record.type,success:true,data});
let pending='';
process.stdin.on('data',chunk=>{pending+=chunk.toString('utf8');for(;;){const end=pending.indexOf('\n');if(end<0)break;const record=JSON.parse(pending.slice(0,end));pending=pending.slice(end+1);trace(record);
 if(record.type==='get_state')reply(record,{model:{provider:'one',id:'shared'},thinkingLevel:'high'});
 else if(record.type==='get_available_models')reply(record,{models:[{provider:'one',id:'shared',reasoning:true},{provider:'two',id:'shared',reasoning:true}]});
 else if(record.type==='get_commands'){
  if(process.env.F5_PI_CASE==='catalog-failure')emit({type:'response',id:record.id,success:false,error:'PRIVATE_FAILURE'});
  else reply(record,{commands:[{source:'skill',name:'skill:review',location:'project'}]});
 } else if(record.type==='prompt'){
  const mode=process.env.F5_PI_CASE;
  if(mode==='tool')emit({type:'tool_execution_start',toolName:'bash'});
  const text=mode==='oversize'?'x'.repeat(600*1024):mode==='invalid-json'?'PRIVATE_FAILURE':JSON.stringify({title:'Inspect Pi metadata',needsRefinement:false});
  emit({type:'message_start',message:{role:'assistant'}});
  emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}});
  emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:mode==='error'?'error':'stop'}});
  if(mode==='retry'){
   emit({type:'message_end',message:{role:'assistant',content:[{type:'text',text}],stopReason:'error'}});
   emit({type:'auto_retry_end',success:true});
  }
  emit({type:'agent_settled',aborted:mode==='abort'});
 } else reply(record,{});
}});
`;
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof NodeServices.layer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));
const fixture = async (
  test: (
    settings: PiLaunchSettings,
    environment: NodeJS.ProcessEnv,
    trace: () => Promise<Record<string, unknown>[]>,
  ) => Promise<void>,
) => {
  const cwd = await mkdtemp(join(tmpdir(), "f5-pi-metadata-test-"));
  const script = writeCliScript(join(cwd, "pi"), source);
  const log = join(cwd, "trace.jsonl");
  try {
    await test(
      {
        binaryPath: script,
        launchArgs: "--extension /never-loaded.ts --tools bash",
      },
      { PATH: process.env.PATH, F5_PI_TRACE: log, F5_PI_MCP_BEARER_TOKEN: "must-be-scrubbed" },
      async () =>
        (await readFile(log, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};

it("probes in a disposable workspace with extensions, tools and inherited MCP credentials disabled", async () =>
  fixture(async (settings, environment, trace) => {
    const catalog = await run(probePiCatalog(settings, environment));
    expect(catalog.models.map((model) => model.slug)).toEqual(["one/shared", "two/shared"]);
    expect(catalog.skills[0]?.name).toBe("review");
    expect(catalog.slashCommands[0]?.name).toBe("compact");
    const spawn = (await trace())[0]!;
    expect((spawn.args as string[]).slice(-3)).toEqual([
      "--no-session",
      "--no-extensions",
      "--no-tools",
    ]);
    expect(spawn.privateEnvironment).toBe(false);
    await expect(stat(String(spawn.cwd))).rejects.toThrow();
  }));
it("fails a broken catalog read instead of replacing a usable catalog with an empty one", async () =>
  fixture(async (settings, environment) => {
    const result = await run(
      probePiCatalog(settings, { ...environment, F5_PI_CASE: "catalog-failure" }).pipe(
        Effect.result,
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_FAILURE");
  }));
it("uses a qualified model and preserves complete assistant output without duplicating deltas", async () =>
  fixture(async (settings, environment, trace) => {
    const text = await run(
      runPiMetadataPrompt({
        settings,
        environment,
        prompt: "title",
        model: "vendor/model/variant",
        thinking: "high",
      }),
    );
    expect(JSON.parse(text)).toEqual({ title: "Inspect Pi metadata", needsRefinement: false });
    const records = await trace();
    expect(records.find((record) => record.type === "set_model")).toMatchObject({
      provider: "vendor",
      modelId: "model/variant",
    });
    expect(records.find((record) => record.type === "set_thinking_level")).toMatchObject({
      level: "high",
    });
    expect(records.filter((record) => record.type === "prompt")).toHaveLength(1);
  }));
it.each(["abort", "error", "tool", "oversize"])(
  "rejects unsuccessful or unsafe metadata outcomes: %s",
  async (mode) =>
    fixture(async (settings, environment, trace) => {
      const result = await run(
        runPiMetadataPrompt({
          settings,
          environment: { ...environment, F5_PI_CASE: mode },
          prompt: "title",
        }).pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expect((await trace()).some((record) => record.type === "prompt")).toBe(true);
    }),
);
it("clears a recovered model error after a successful native retry", async () =>
  fixture(async (settings, environment) => {
    const text = await run(
      runPiMetadataPrompt({
        settings,
        environment: { ...environment, F5_PI_CASE: "retry" },
        prompt: "title",
      }),
    );
    expect(JSON.parse(text).title).toBe("Inspect Pi metadata");
  }));
it("validates generated JSON through the shared title contract", async () =>
  fixture(async (settings, environment) => {
    const title = await run(
      Effect.gen(function* () {
        const service = yield* makePiTextGeneration(settings, environment);
        return yield* service.generateThreadTitle({
          cwd: "/must-not-be-used",
          message: "Review transport",
        });
      }),
    );
    expect(title).toEqual({ title: "Inspect Pi metadata", needsRefinement: false });
    const rejected = await run(
      Effect.gen(function* () {
        const service = yield* makePiTextGeneration(settings, {
          ...environment,
          F5_PI_CASE: "invalid-json",
        });
        return yield* service.generateThreadTitle({
          cwd: "/must-not-be-used",
          message: "Review transport",
        });
      }).pipe(Effect.result),
    );
    expect(rejected._tag).toBe("Failure");
    expect(JSON.stringify(rejected)).not.toContain("PRIVATE_FAILURE");
  }));
it("checks account admission before spawning metadata processes", async () =>
  fixture(async (settings, environment, trace) => {
    const result = await run(
      runPiMetadataPrompt({
        settings,
        environment,
        prompt: "title",
        beforeLaunch: Effect.fail(
          new PiRpcError({ operation: "account", detail: "Account change in progress." }),
        ),
      }).pipe(Effect.result),
    );
    expect(result._tag).toBe("Failure");
    await expect(trace()).rejects.toThrow();
  }));
