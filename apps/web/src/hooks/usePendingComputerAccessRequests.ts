import { useEffect, useMemo, useState } from "react";
import type { ComputerAccessPush } from "@t3tools/contracts";
import { useAgentComputerActivityStore } from "../agentComputerActivityStore";

/** Deadlines affect attention, never the host's consent decision or retained request history. */
export function usePendingComputerAccessRequests() {
  const requests = useAgentComputerActivityStore((state) => state.requests);
  const [now, setNow] = useState(Date.now);
  useEffect(() => setNow(Date.now()), [requests]);
  useEffect(() => {
    const deadlines = Object.values(requests).flatMap((request) =>
      request && !request.settled && request.expiresAtMs !== undefined && request.expiresAtMs > now
        ? [request.expiresAtMs]
        : [],
    );
    if (!deadlines.length) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(...deadlines) - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [requests, now]);
  return useMemo(
    () =>
      Object.values(requests).filter(
        (request): request is typeof ComputerAccessPush.Type =>
          !!request &&
          !request.settled &&
          (request.expiresAtMs === undefined || request.expiresAtMs > now),
      ),
    [requests, now],
  );
}
