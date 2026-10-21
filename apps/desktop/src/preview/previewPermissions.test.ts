import { expect, it, vi } from "vitest";

import { installPreviewPermissionPolicy } from "./previewPermissions";

it("lets preview pages copy and go fullscreen, and denies everything else", () => {
  let request:
    | ((contents: unknown, permission: string, done: (ok: boolean) => void) => void)
    | null = null;
  let check: ((contents: unknown, permission: string) => boolean) | null = null;
  const session = {
    setPermissionRequestHandler: vi.fn((handler: typeof request) => {
      request = handler;
    }),
    setPermissionCheckHandler: vi.fn((handler: typeof check) => {
      check = handler;
    }),
  };
  installPreviewPermissionPolicy(session);
  installPreviewPermissionPolicy(session);
  expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);

  const granted = (permission: string) => {
    let result: boolean | undefined;
    request!({}, permission, (ok) => {
      result = ok;
    });
    return result;
  };
  expect(granted("clipboard-sanitized-write")).toBe(true);
  expect(granted("fullscreen")).toBe(true);
  for (const permission of [
    "openExternal",
    "clipboard-read",
    "notifications",
    "geolocation",
    "media",
    "local-fonts",
  ]) {
    expect(granted(permission)).toBe(false);
  }
  expect(check!({}, "clipboard-sanitized-write")).toBe(true);
  expect(check!({}, "media")).toBe(false);
});
