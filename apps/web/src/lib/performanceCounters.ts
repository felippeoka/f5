type Work =
  | "rowRenders"
  | "timelineDerivations"
  | "timelineContentUpdates"
  | "markdownParsedCharacters"
  | "markdownValidatedCharacters"
  | "highlightJobs"
  | "highlightBytes";
type Gauge = "highlightJobs" | "highlightBytes";
interface BrowserPerformanceSnapshot {
  work: Partial<Record<Work, number>>;
  gauges: Partial<Record<Gauge, number>>;
  rowRenders: Record<string, number>;
  resources?: Record<string, Record<string, number>>;
}
interface BrowserPerformanceCounters extends BrowserPerformanceSnapshot {
  sample?: () => BrowserPerformanceSnapshot;
}
declare global {
  interface Window {
    /** Installed by the existing production-browser runner before app startup. */
    __f5PerformanceCounters?: BrowserPerformanceCounters;
  }
}
const counters = typeof window === "undefined" ? undefined : window.__f5PerformanceCounters;
const readers = new Map<string, () => Record<string, number>>();
if (counters)
  counters.sample = () => ({
    work: { ...counters.work },
    gauges: { ...counters.gauges },
    rowRenders: { ...counters.rowRenders },
    resources: Object.fromEntries([...readers].map(([name, read]) => [name, read()])),
  });
export function registerBrowserResourceReader(
  name: "store" | "transport",
  read: () => Record<string, number>,
) {
  if (counters) readers.set(name, read);
  return () => {
    if (readers.get(name) === read) readers.delete(name);
  };
}
export function recordBrowserWork(name: Work, amount = 1) {
  if (counters) counters.work[name] = (counters.work[name] ?? 0) + amount;
}
export function recordBrowserGauge(name: Gauge, value: number) {
  if (counters) counters.gauges[name] = value;
}
export function recordTimelineRowRender(id: string) {
  if (!counters) return;
  recordBrowserWork("rowRenders");
  // Only retain a bounded sample of row identities, even in a long soak.
  if (!Object.hasOwn(counters.rowRenders, id) && Object.keys(counters.rowRenders).length >= 2048)
    delete counters.rowRenders[Object.keys(counters.rowRenders)[0]!];
  counters.rowRenders[id] = (counters.rowRenders[id] ?? 0) + 1;
}
