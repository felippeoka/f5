import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("samples bounded row work and resources only when the production runner opts in", async () => {
  const target = { work: {}, gauges: {}, rowRenders: Object.create(null) } as NonNullable<
    Window["__f5PerformanceCounters"]
  >;
  vi.stubGlobal("window", { __f5PerformanceCounters: target });
  const probe = await import("./performanceCounters");
  probe.recordBrowserWork("markdownParsedCharacters", 12);
  probe.recordBrowserGauge("highlightJobs", 2);
  probe.recordTimelineRowRender("visible");
  probe.recordTimelineRowRender("visible");
  const remove = probe.registerBrowserResourceReader("transport", () => ({ pendingRpcs: 3 }));
  expect(target.sample!()).toMatchObject({
    work: { markdownParsedCharacters: 12, rowRenders: 2 },
    gauges: { highlightJobs: 2 },
    rowRenders: { visible: 2 },
    resources: { transport: { pendingRpcs: 3 } },
  });
  remove();
  for (let index = 0; index < 3000; index++) probe.recordTimelineRowRender(`row-${index}`);
  expect(Object.keys(target.sample!().rowRenders)).toHaveLength(2048);
  expect(target.sample!().resources).toEqual({});
});
it("old disposers cannot remove the replacement transport reader", async () => {
  const target = { work: {}, gauges: {}, rowRenders: Object.create(null) } as NonNullable<
    Window["__f5PerformanceCounters"]
  >;
  vi.stubGlobal("window", { __f5PerformanceCounters: target });
  const probe = await import("./performanceCounters");
  const old = probe.registerBrowserResourceReader("transport", () => ({ pending: 1 }));
  const replacement = probe.registerBrowserResourceReader("transport", () => ({ pending: 0 }));
  old();
  expect(target.sample!().resources).toEqual({ transport: { pending: 0 } });
  replacement();
  expect(target.sample!().resources).toEqual({});
});
it("does no collection during normal application use", async () => {
  const normalWindow = {};
  vi.stubGlobal("window", normalWindow);
  const probe = await import("./performanceCounters");
  probe.recordBrowserWork("rowRenders");
  probe.recordBrowserGauge("highlightBytes", 123);
  probe.recordTimelineRowRender("ignored");
  probe.registerBrowserResourceReader("store", () => {
    throw new Error("must not sample");
  });
  expect(normalWindow).toEqual({});
});
