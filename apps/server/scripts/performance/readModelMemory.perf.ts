import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { measureEngineHydration } from "./assistantStream.ts";

// Child of measureReadModelMemory: one engine hydration in a fresh process.
it("measures engine hydration memory in a fresh process", async () => {
  const directory = process.env.F5_PERF_READ_MODEL_DIR;
  const output = process.env.F5_PERF_READ_MODEL_OUTPUT;
  if (!directory || !output)
    throw new Error("Run through measureReadModelMemory; the seeded directory is required");
  const result = await measureEngineHydration(directory);
  writeFileSync(output, JSON.stringify(result), { flag: "wx" });
}, 300_000);
