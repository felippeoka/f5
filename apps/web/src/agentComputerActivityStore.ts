import { create } from "zustand";
import type {
  ComputerActivity,
  ComputerGrant,
  ComputerAccessPush,
  ComputerAccessSettled,
  AgentComputerUseChanged,
  AgentComputerUseHolder,
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
  /** Every holder in this profile: delivery, target app, execution state and pause cause. */
  leases: typeof AgentComputerUseChanged.Type;
  lastLeaseAt: Record<string, number | undefined>;
  record: (activity: ComputerActivity) => void;
  request: (request: typeof ComputerAccessPush.Type) => void;
  settle: (event: typeof ComputerAccessSettled.Type) => void;
  setGrants: (threadId: string, grants: ReadonlyArray<ComputerGrant>) => void;
  setPaused: (threadId: string, paused: boolean) => void;
  resetConnection: () => void;
  setLeases: (leases: typeof AgentComputerUseChanged.Type) => void;
}
const NO_LEASES: typeof AgentComputerUseChanged.Type = { holders: [] };
export const useAgentComputerActivityStore = create<ComputerState>((set) => ({
  resetConnection: () =>
    set({
      appNames: {},
      activity: {},
      lastCapture: {},
      grants: {},
      requests: {},
      paused: {},
      leases: NO_LEASES,
      lastLeaseAt: {},
    }),
  appNames: {},
  activity: {},
  lastCapture: {},
  grants: {},
  requests: {},
  paused: {},
  leases: NO_LEASES,
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
  setLeases: (leases) =>
    set((state) => {
      const now = Date.now();
      const removed = state.leases.holders.filter(
        (holder) => !leases.holders.some((next) => next.threadId === holder.threadId),
      );
      return {
        leases,
        appNames: {
          ...state.appNames,
          ...Object.fromEntries(
            leases.holders.flatMap((holder) =>
              holder.appId && holder.appName ? [[holder.appId, holder.appName]] : [],
            ),
          ),
        },
        lastLeaseAt: removed.length
          ? {
              ...state.lastLeaseAt,
              ...Object.fromEntries(removed.map((holder) => [holder.threadId, now])),
            }
          : state.lastLeaseAt,
      };
    }),
}));
export function computerHolderFor(
  leases: typeof AgentComputerUseChanged.Type,
  threadId: string,
): AgentComputerUseHolder | undefined {
  return leases.holders.find((holder) => holder.threadId === threadId);
}
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
