import type { Session, WebContents } from "electron";

/**
 * Stops main-frame navigations refused from a `did-start-navigation` listener.
 *
 * Electron runs that listener inside Chromium's DidStartNavigation, and calling `stop()` there
 * frees the NavigationRequest Chromium is still using, which segfaults the main process. The
 * stop is deferred until the listener returns and dropped when a newer main-frame navigation
 * has started since, so it never cancels a navigation that was allowed. By then the request
 * may already be on the wire; `gateMainFrameRequests` is what keeps it off the network.
 */
export interface DeferredNavigationStopper {
  /** Call for every main-frame, cross-document `did-start-navigation`, allowed or not. */
  readonly navigationStarted: () => void;
  /** Stops the navigation that just started once the listener returns, unless superseded. */
  readonly stopCurrentNavigation: () => void;
}

export function createDeferredNavigationStopper(contents: WebContents): DeferredNavigationStopper {
  let generation = 0;
  return {
    navigationStarted: () => {
      generation += 1;
    },
    stopCurrentNavigation: () => {
      const scheduledGeneration = generation;
      setImmediate(() => {
        if (generation === scheduledGeneration && !contents.isDestroyed()) contents.stop();
      });
    },
  };
}

type RefuseMainFrameRequest = (url: string) => boolean;

const refusersByWebContentsId = new Map<number, RefuseMainFrameRequest>();
const gatedSessions = new WeakSet<Session>();

function installSessionGate(session: Session): void {
  if (gatedSessions.has(session)) return;
  gatedSessions.add(session);
  // Electron keeps one `onBeforeRequest` listener per session, so this must stay the only one
  // registered on preview sessions.
  session.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"], types: ["mainFrame"] },
    (details, callback) => {
      const refuse =
        details.webContentsId === undefined
          ? undefined
          : refusersByWebContentsId.get(details.webContentsId);
      callback({ cancel: refuse?.(details.url) ?? false });
    },
  );
}

/**
 * Cancels main-frame requests from `contents` that `refuse` rejects before they leave the app.
 * History and reload navigations skip `will-navigate`, so without this their request reaches
 * the server before the deferred stop lands. Returns a function that removes the gate.
 */
export function gateMainFrameRequests(
  contents: WebContents,
  refuse: RefuseMainFrameRequest,
): () => void {
  const webContentsId = contents.id;
  installSessionGate(contents.session);
  refusersByWebContentsId.set(webContentsId, refuse);
  const remove = () => {
    contents.off("destroyed", remove);
    if (refusersByWebContentsId.get(webContentsId) === refuse) {
      refusersByWebContentsId.delete(webContentsId);
    }
  };
  contents.once("destroyed", remove);
  return remove;
}
