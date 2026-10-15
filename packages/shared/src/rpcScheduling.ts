export type RpcLane = "ordinary" | "stop" | "answer" | "recovery";

/** Inspect the decoded command as well as its transport method. */
export function rpcLane(body: { readonly _tag: string; readonly command?: unknown }): RpcLane {
  const command =
    body.command && typeof body.command === "object" && "type" in body.command
      ? String(body.command.type)
      : "";
  if (
    command === "thread.turn.interrupt" ||
    command === "thread.session.stop" ||
    /(?:cancel|interrupt|stopSession|revoke)$/i.test(body._tag)
  )
    return "stop";
  if (
    command === "thread.approval.respond" ||
    command === "thread.user-input.respond" ||
    command === "thread.turn.steer" ||
    /(?:respondToRequest|respondToUserInput|respondToElicitation|elicitation.submit|automation.respond)$/i.test(
      body._tag,
    )
  )
    return "answer";
  if (
    /^orchestration\.(?:getStartupSnapshot|getSnapshot|getThread|replayEvents)/.test(body._tag) ||
    body._tag === "terminal.snapshot" ||
    body._tag === "server.probe"
  )
    return "recovery";
  return "ordinary";
}

export const RPC_LANE_LIMITS: Readonly<Record<RpcLane, number>> = {
  ordinary: 8,
  stop: 1,
  answer: 2,
  recovery: 1,
};
export const RPC_ORDINARY_BYTES = 80 * 1024 * 1024;

/** No waiting queue: reject overload before executing or retaining its payload. */
export class RpcAdmission {
  private readonly counts: Record<RpcLane, number> = {
    ordinary: 0,
    stop: 0,
    answer: 0,
    recovery: 0,
  };
  private readonly bytes: Record<RpcLane, number> = {
    ordinary: 0,
    stop: 0,
    answer: 0,
    recovery: 0,
  };
  claim(lane: RpcLane, bytes: number): (() => void) | null {
    const budget = lane === "ordinary" ? RPC_ORDINARY_BYTES : 40 * 1024 * 1024;
    if (this.counts[lane] >= RPC_LANE_LIMITS[lane] || this.bytes[lane] + bytes > budget)
      return null;
    this.counts[lane]++;
    this.bytes[lane] += bytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.counts[lane]--;
      this.bytes[lane] -= bytes;
    };
  }
}

/** Used only for connectivity admission, never authorization. Unknown methods require reconciliation. */
export function isReadOnlyRpc(method: string): boolean {
  return (
    /(?:^|\.)(?:get|list|read|search|inspect|probe|browse|status|diff|log|show|resolve)[A-Z.]?/.test(
      method,
    ) || method === "terminal.snapshot"
  );
}
