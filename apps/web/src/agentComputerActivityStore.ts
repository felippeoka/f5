import { create } from "zustand";
import type {
  ComputerActivity,
  ComputerGrant,
  ComputerAccessPush,
  ComputerAccessSettled,
  AgentComputerUseChanged,
} from "@t3tools/contracts";
import { isAgentActivityRecent } from "./agentActivityWindow";
interface ComputerState {
  appNames: Record<string, string | undefined>;
  activity: Record<string, (ComputerActivity & { at: number }) | undefined>;
  lastCapture: Record<string, (ComputerActivity & { at: number }) | undefined>;
  grants: Record<string, ReadonlyArray<ComputerGrant> | undefined>;
  requests: Record<
    string,
    (typeof ComputerAccessPush.Type & { settled?: boolean; allowed?: boolean }) | undefined
  >;
  paused: Record<string, boolean | undefined>;
  lease: typeof AgentComputerUseChanged.Type;
  lastLeaseAt: Record<string, number | undefined>;
  record: (activity: ComputerActivity) => void;
  request: (request: typeof ComputerAccessPush.Type) => void;
  settle: (event: typeof ComputerAccessSettled.Type) => void;
  setGrants: (threadId: string, grants: ReadonlyArray<ComputerGrant>) => void;
  setPaused: (threadId: string, paused: boolean) => void;
  resetConnection: () => void;
  setLease: (lease: typeof AgentComputerUseChanged.Type) => void;
}
export const useAgentComputerActivityStore = create<ComputerState>((set) => ({
  resetConnection: () =>
    set({
      appNames: {},
      activity: {},
      lastCapture: {},
      grants: {},
      requests: {},
      paused: {},
      lease: { threadId: null },
      lastLeaseAt: {},
    }),
  appNames: {},
  activity: {},
  lastCapture: {},
  grants: {},
  requests: {},
  paused: {},
  lease: { threadId: null },
  lastLeaseAt: {},
  record: (activity) =>
    set((state) => {
      const { thumbnailDataUrl, ...summary } = activity;
      const at = Date.now();
      const previous = state.lastCapture[activity.threadId];
      return {
        activity: { ...state.activity, [activity.threadId]: { ...summary, at } },
        lastCapture: {
          ...state.lastCapture,
          [activity.threadId]:
            activity.status === "completed" && thumbnailDataUrl
              ? { ...activity, at }
              : previous?.backend === activity.backend
                ? previous
                : undefined,
        },
      };
    }),
  request: (request) =>
    set((state) => ({
      requests: { ...state.requests, [request.requestId]: request },
      appNames: {
        ...state.appNames,
        ...Object.fromEntries(request.apps.map((app) => [app.appId, app.name])),
      },
    })),
  settle: (event) =>
    set((state) => {
      const request = state.requests[event.requestId];
      return request
        ? {
            requests: {
              ...state.requests,
              [event.requestId]: { ...request, settled: true, allowed: event.allowed },
            },
          }
        : state;
    }),
  setGrants: (threadId, grants) =>
    set((state) => ({
      grants: { ...state.grants, [threadId]: grants },
      // A capture may include every granted app; discard it on any grant change.
      lastCapture: { ...state.lastCapture, [threadId]: undefined },
    })),
  setPaused: (threadId, paused) =>
    set((state) => ({ paused: { ...state.paused, [threadId]: paused } })),
  setLease: (lease) =>
    set((state) => ({
      lease,
      lastLeaseAt:
        state.lease.threadId && state.lease.threadId !== lease.threadId
          ? { ...state.lastLeaseAt, [state.lease.threadId]: Date.now() }
          : state.lastLeaseAt,
    })),
}));
export function isAgentComputerActive(
  activity: (ComputerActivity & { at: number }) | undefined,
  now: number,
  held: boolean,
  lastLeaseAt?: number,
): boolean {
  return (
    held ||
    (lastLeaseAt !== undefined && isAgentActivityRecent(lastLeaseAt, now)) ||
    (!!activity && (activity.status === "started" || isAgentActivityRecent(activity.at, now)))
  );
}
