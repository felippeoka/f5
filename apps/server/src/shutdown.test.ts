import { expect, it, vi } from "vitest";
import { ShutdownRegistry } from "./shutdown.ts";

it("shares an absolute deadline, runs phases in order, and settles incomplete work", async () => {
  vi.useFakeTimers();
  try {
    const shutdown = new ShutdownRegistry();
    const order: string[] = [];
    const deadlines: number[] = [];
    const add = (
      name: string,
      phase: "admission" | "flush" | "producers" | "drain",
      work = async () => {},
    ) =>
      shutdown.register({
        name,
        phase,
        run: async (deadline) => {
          deadlines.push(deadline);
          order.push(name);
          await work();
        },
      });
    add("admission", "admission");
    add("history", "flush", () => new Promise((resolve) => setTimeout(resolve, 200)));
    add("logs", "flush");
    add("provider", "producers", () => new Promise(() => {}));
    add("ingestion", "drain");
    const work = shutdown.run();
    expect(shutdown.run()).toBe(work);
    await vi.advanceTimersByTimeAsync(1800);
    const results = await work;
    expect(new Set(deadlines).size).toBe(1);
    expect(order).toEqual(["admission", "history", "logs", "provider", "ingestion"]);
    expect(results.find((step) => step.name === "provider")?.outcome).toBe("incomplete");
    expect(results.find((step) => step.name === "ingestion")?.outcome).toBe("complete");
  } finally {
    vi.useRealTimers();
  }
});
