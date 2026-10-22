import { expect, it } from "vitest";

import {
  allowsAppPermission,
  blocksEmbeddedFrameNavigation,
  installAppFramePermissionPolicy,
} from "./appFramePolicy";

const navigation = (frameUrl: string | undefined, url: string, isMainFrame = false) => ({
  isMainFrame,
  isSameDocument: false,
  frameUrl,
  url,
});

it("keeps an HTML render or MCP app from navigating its frame anywhere else", () => {
  // Script navigation, a meta refresh and a form submission all reach this as a frame navigation.
  expect(
    blocksEmbeddedFrameNavigation(navigation("about:srcdoc", "https://attacker.example/?d=1")),
  ).toBe(true);
  expect(blocksEmbeddedFrameNavigation(navigation("about:srcdoc", "data:text/html,x"))).toBe(true);
  expect(blocksEmbeddedFrameNavigation(navigation("about:srcdoc", "f5://new?prompt=x"))).toBe(true);
});

it("lets a frame load its own document and leaves other frames and the app alone", () => {
  expect(blocksEmbeddedFrameNavigation(navigation(undefined, "about:srcdoc"))).toBe(false);
  expect(blocksEmbeddedFrameNavigation(navigation("about:blank", "about:srcdoc"))).toBe(false);
  expect(blocksEmbeddedFrameNavigation(navigation("about:srcdoc", "about:srcdoc"))).toBe(false);
  expect(
    blocksEmbeddedFrameNavigation({
      ...navigation("about:srcdoc", "about:srcdoc#section"),
      isSameDocument: true,
    }),
  ).toBe(false);
  // Workspace media frames load server asset URLs.
  expect(
    blocksEmbeddedFrameNavigation(navigation("", "http://127.0.0.1:3773/api/assets/x.pdf")),
  ).toBe(false);
  expect(
    blocksEmbeddedFrameNavigation(navigation("about:srcdoc", "https://example.com/", true)),
  ).toBe(false);
});

it("denies embedded frames the camera, microphone and location but keeps the app's own", () => {
  for (const permission of ["media", "geolocation", "notifications", "clipboard-read"]) {
    expect(allowsAppPermission(permission, { isMainFrame: false })).toBe(false);
    expect(allowsAppPermission(permission, { isMainFrame: true })).toBe(true);
  }
  expect(allowsAppPermission("clipboard-sanitized-write", { isMainFrame: false })).toBe(true);
});

it("installs both handlers once per session", () => {
  const calls: string[] = [];
  let request: ((permission: string, isMainFrame: boolean) => boolean) | undefined;
  const session = {
    setPermissionRequestHandler: (
      handler: (
        contents: unknown,
        permission: string,
        callback: (granted: boolean) => void,
        details: { isMainFrame?: boolean },
      ) => void,
    ) => {
      calls.push("request");
      request = (permission, isMainFrame) => {
        let granted = true;
        handler(null, permission, (value) => (granted = value), { isMainFrame });
        return granted;
      };
    },
    setPermissionCheckHandler: () => calls.push("check"),
  };
  installAppFramePermissionPolicy(session);
  installAppFramePermissionPolicy(session);
  expect(calls).toEqual(["request", "check"]);
  expect(request?.("media", false)).toBe(false);
  expect(request?.("media", true)).toBe(true);
});
