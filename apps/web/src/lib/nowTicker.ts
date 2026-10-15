import { useCallback, useState, useSyncExternalStore } from "react";

/**
 * One shared 1 Hz clock. The interval runs only while something subscribes,
 * and `getSnapshot` returns the cached tick so every subscriber renders the
 * same value and unrelated renders never see a fresh `Date.now()`.
 */
export const NOW_TICK_INTERVAL_MS = 1000;

const listeners = new Set<() => void>();
const systemClock = () => Date.now();
let readClock: () => number = systemClock;
let lastTick = readClock();
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
  lastTick = readClock();
  for (const listener of listeners) listener();
}

// Background tabs throttle intervals; catch up as soon as the page is visible.
function onVisibilityChange(): void {
  if (typeof document !== "undefined" && document.visibilityState === "visible") tick();
}

function start(): void {
  lastTick = readClock();
  timer = setInterval(tick, NOW_TICK_INTERVAL_MS);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
}

function stop(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  if (typeof document !== "undefined") {
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
}

export function subscribeNow(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) start();
  return () => {
    if (!listeners.delete(listener)) return;
    if (listeners.size === 0) stop();
  };
}

export function getNowSnapshot(): number {
  return lastTick;
}

export function isNowTickerRunning(): boolean {
  return timer !== null;
}

/** Test seam: replaces the clock (null restores it) and notifies subscribers immediately. */
export function setNowTickerClockForTests(clock: (() => number) | null): void {
  readClock = clock ?? systemClock;
  tick();
}

const noopUnsubscribe = () => {};

/**
 * Epoch milliseconds that advance once per second while `enabled`. Disabled
 * callers get their mount-time value and do not subscribe, so only the leaf
 * that displays a live duration re-renders on each tick.
 */
export function useNow(enabled: boolean): number {
  const [mountedAt] = useState(() => readClock());
  const subscribe = useCallback(
    (listener: () => void) => (enabled ? subscribeNow(listener) : noopUnsubscribe),
    [enabled],
  );
  const getSnapshot = enabled ? getNowSnapshot : () => mountedAt;
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useNowIso(enabled: boolean): string {
  return new Date(useNow(enabled)).toISOString();
}
