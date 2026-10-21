/**
 * Permissions a preview page may use. Preview tabs run untrusted pages, and Electron approves
 * every request when a session has no handler, so without this a page could read the
 * clipboard, post notifications, ask for location, camera or microphone as F5, or launch
 * an app through a custom scheme (`openExternal`).
 *
 * `clipboard-sanitized-write` backs `navigator.clipboard.writeText()`, so a page's Copy
 * buttons work; the check handler gates it too, so both handlers allow it. `fullscreen`
 * fills the preview's own webview, since guests attach with HTML fullscreen window resizing
 * disabled.
 */
export const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
]);

interface PermissionSessionLike {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string) => boolean): void;
}

const installedSessions = new WeakSet<object>();

/** Installed once per preview session, before its first guest loads a page. */
export function installPreviewPermissionPolicy(session: PermissionSessionLike): void {
  if (installedSessions.has(session)) return;
  installedSessions.add(session);
  session.setPermissionRequestHandler((_webContents, permission, callback) =>
    callback(ALLOWED_PREVIEW_PERMISSIONS.has(permission)),
  );
  session.setPermissionCheckHandler((_webContents, permission) =>
    ALLOWED_PREVIEW_PERMISSIONS.has(permission),
  );
}
