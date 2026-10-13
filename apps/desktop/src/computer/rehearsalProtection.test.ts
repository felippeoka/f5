import { expect, it } from "vitest";
import type { ComputerAutomationError, ComputerInspectResult } from "@t3tools/contracts";
import { ComputerControlError } from "@t3tools/shared/computerControl";
import {
  BROWSER_PROTECTION_IDS,
  BROWSER_SECURE_LABEL,
  BROWSER_SECURE_SENTINEL,
  browserProtectionHtml,
  browserSecureInspection,
  expectedProtectionRefusal,
  protectionFixtureState,
} from "./rehearsalProtection";

it("requires the exact protection refusal rather than an unrelated failure", () => {
  const errors: ComputerAutomationError[] = [
    { _tag: "NotGranted", needed: "type" },
    { _tag: "TargetBlocked", kind: "secure-field" },
    { _tag: "NotGranted", needed: "view" },
    { _tag: "Unavailable", reason: "missing-permissions" },
    { _tag: "TargetBlocked", kind: "focus-unknown" },
    { _tag: "StaleElement" },
  ];
  for (const [index, error] of errors.entries()) {
    const failure = new ComputerControlError(error);
    expect(expectedProtectionRefusal(failure, "typing-grant")).toBe(index === 0);
    expect(expectedProtectionRefusal(failure, "secure-field")).toBe(index === 1);
    expect(expectedProtectionRefusal(failure, "view-grant")).toBe(index === 2);
  }
  expect(expectedProtectionRefusal(new Error("NotGranted"), "typing-grant")).toBe(false);
});

it("keeps only bounded independent page observations", () => {
  const state = { ready: true, secureFocused: true, secureUnchanged: true, inputEvents: 0 };
  expect(protectionFixtureState({ ...state, value: "PRIVATE_SENTINEL" })).toEqual(state);
  for (const update of [
    { ready: false },
    { inputEvents: -1 },
    { inputEvents: 1.5 },
    { inputEvents: 1001 },
    { secureFocused: "true" },
    { secureUnchanged: undefined },
  ])
    expect(protectionFixtureState({ ...state, ...update })).toBeUndefined();
  expect(protectionFixtureState(null)).toBeUndefined();
});

it("rejects missing, ambiguous or exposed secure fields before any keyboard attempt", () => {
  const secure = {
    elementRef: "secure",
    role: "AXTextField",
    name: BROWSER_SECURE_LABEL,
    focused: true,
    enabled: true,
    actions: [],
  };
  const snapshot: ComputerInspectResult = {
    snapshotId: "snapshot",
    appId: BROWSER_PROTECTION_IDS.browser,
    accessible: true,
    nodes: [secure],
  };
  expect(browserSecureInspection(snapshot)).toBe(true);
  for (const update of [
    { appId: "other" },
    { accessible: false },
    { nodes: [] },
    { nodes: [secure, secure] },
    { nodes: [{ ...secure, value: "redacted" }] },
    { nodes: [{ ...secure, focused: false }] },
    { nodes: [{ ...secure, actions: ["setValue" as const] }] },
    { nodes: [secure, { ...secure, name: "other", value: BROWSER_SECURE_SENTINEL }] },
  ])
    expect(browserSecureInspection({ ...snapshot, ...update })).toBe(false);
});

it("serves a local synthetic password fixture without exporting its value", () => {
  const html = browserProtectionHtml(`/${"a".repeat(32)}/state`);
  expect(html).toContain('type="password"');
  expect(html).toContain("secureUnchanged:secure.value===");
  expect(html).not.toContain("value:secure.value");
  expect(html).not.toMatch(/https?:/);
  expect(() => browserProtectionHtml("/state</script>")).toThrow();
});
