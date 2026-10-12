import { useEffect, useState } from "react";
import type { ComputerAccessPush } from "@t3tools/contracts";

import { readNativeApi } from "../nativeApi";
import { useAgentComputerActivityStore } from "../agentComputerActivityStore";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription, DialogHeader } from "./ui/dialog";

export function ComputerAccessCard({
  request,
  settled,
  allowed,
}: {
  request: typeof ComputerAccessPush.Type;
  settled?: boolean | undefined;
  allowed?: boolean | undefined;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bridge = window.desktopBridge?.computerAutomation;
  const review = async (trusted: boolean) => {
    if (!bridge || !trusted || settled || sending) return;
    setSending(true);
    setError("");
    try {
      await bridge.answerAccess({
        requestId: request.requestId,
        backendIncarnation: request.backendIncarnation,
        decisions: [],
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not answer computer access.");
      setSending(false);
    }
  };
  return (
    <div className="space-y-3 p-4 text-sm" data-testid="computer-access-card">
      <p>{request.reason}</p>
      {request.chromeSetup ? (
        <div className="space-y-2 break-all rounded-md border p-3">
          <p>Current targets:</p>
          {request.chromeSetup.previousTargets.map((target) => (
            <p key={target}>{target}</p>
          ))}
          <p>
            New target for {request.chromeSetup.provider}: {request.chromeSetup.targetPath}
          </p>
          <p>This integration can act on sites you are signed in to.</p>
        </div>
      ) : null}
      {request.apps.map((app) => (
        <div key={app.appId} className="space-y-2 rounded-md border p-3">
          <p className="font-medium">
            {app.name} · {app.tier}
          </p>
          {app.warning === "browser" ? (
            <p>This app can act on sites you are signed in to.</p>
          ) : null}
          {app.tier === "click" ? (
            <p>Typing here can run commands. Choose typing separately in the native dialog.</p>
          ) : null}
          {app.tier === "full" ? <p>Control includes typing in this app.</p> : null}
        </div>
      ))}
      {settled ? (
        <p role="status">{allowed ? "Access allowed" : "Access denied or expired"}</p>
      ) : !bridge ? (
        <p>Answer on the computer running F5.</p>
      ) : (
        <div className="space-y-2">
          <p>Choose access and remembering in F5's native dialog.</p>
          <Button disabled={sending} onClick={(event) => void review(event.isTrusted)}>
            Review access
          </Button>
        </div>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
/** Mounted once per app window. Consent stays visible even when its thread is not selected. */
export function ComputerAccessInbox() {
  const requests = useAgentComputerActivityStore((state) => state.requests);
  useEffect(() => {
    const api = readNativeApi();
    if (!api?.computer) return;
    const store = useAgentComputerActivityStore.getState();
    const off = [
      api?.computer?.access.onRequested(store.request),
      api?.computer?.access.onSettled(store.settle),
      api?.computer?.access.onGrantsChanged((event) =>
        store.setGrants(event.threadId, event.grants),
      ),
      api?.computer?.onActivity(store.record),
      api?.computer?.onLeaseChanged(store.setLease),
      api?.preview.automation.onPauseChanged((event) =>
        store.setPaused(event.threadId, event.paused),
      ),
    ];
    return () => off.forEach((unsubscribe) => unsubscribe?.());
  }, []);
  const request = Object.values(requests).find((entry) => entry && !entry.settled);
  if (!request || !window.desktopBridge?.computerAutomation) return null;
  return (
    <Dialog open>
      <DialogPopup showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {request.kind === "chrome-setup" ? "Browser integration setup" : "Computer access"}
          </DialogTitle>
          <DialogDescription>
            {request.kind === "chrome-setup"
              ? "Review the browser registration change before allowing it."
              : "Choose which apps the agent can use for this session."}
          </DialogDescription>
        </DialogHeader>
        <ComputerAccessCard key={request.requestId} request={request} />
      </DialogPopup>
    </Dialog>
  );
}
export function ComputerAccessTimeline({ threadId }: { threadId: string }) {
  const requests = useAgentComputerActivityStore((state) => state.requests);
  const history = Object.values(requests)
    .filter((request) => request?.threadId === threadId)
    .slice(-20);
  if (!history.length) return null;
  return (
    <details className="shrink-0 rounded-lg border text-sm">
      <summary className="cursor-pointer px-3 py-2">
        Computer access · {history.length} recent requests
      </summary>
      <div className="max-h-48 overflow-y-auto">
        {history.map((request) =>
          request ? (
            <div key={request.requestId} className="border-t">
              <ComputerAccessCard
                request={request}
                settled={request.settled}
                allowed={request.allowed}
              />
            </div>
          ) : null,
        )}
      </div>
    </details>
  );
}
