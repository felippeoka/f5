import { describe, expect, it } from "vitest";
import { ComputerGrantAuthority } from "./ComputerGrantAuthority";
import type {
  ComputerAccessRequested,
  ComputerAccessAnswer,
  ComputerAuthorization,
} from "@t3tools/contracts";
const request: ComputerAccessRequested = {
  requestId: "r",
  threadId: "t",
  projectId: "p",
  sessionGeneration: "s",
  kind: "apps",
  reason: "Edit",
  apps: [{ appId: "com.apple.TextEdit", name: "TextEdit", tier: "full" }],
};
const answer: ComputerAccessAnswer = {
  requestId: "r",
  backendIncarnation: "b",
  decisions: [{ appId: "com.apple.TextEdit", allow: true, allowTyping: false, remember: true }],
};
const auth: ComputerAuthorization = {
  profileId: "profile",
  projectId: "p",
  threadId: "t",
  sessionGeneration: "s",
  turnId: "turn",
  executionGeneration: 1,
  grantVersion: 1,
  grants: [],
};
function approve(authority: ComputerGrantAuthority, remember = true) {
  const result = authority.issue("profile", request, {
    ...answer,
    decisions: [{ ...answer.decisions[0]!, remember }],
  });
  return {
    appId: "com.apple.TextEdit",
    tier: "full" as const,
    allowTyping: false,
    receipt: result.decisions[0]!.receipt!,
  };
}
describe("desktop consent receipts", () => {
  it("refuses file-forged grants and stale receipts after F5 restarts", () => {
    const authority = new ComputerGrantAuthority("darwin");
    const grant = approve(authority);
    expect(
      authority.validate({
        ...auth,
        grants: [{ appId: grant.appId, tier: "full", allowTyping: false }],
      }).grants,
    ).toEqual([]);
    expect(authority.remembered("profile", "p", [grant])).toEqual([grant]);
    expect(new ComputerGrantAuthority("darwin").remembered("profile", "p", [grant])).toEqual([]);
  });
  it("binds approval to identity, tier, typing, profile and project", () => {
    const authority = new ComputerGrantAuthority("darwin");
    const grant = approve(authority);
    expect(authority.validate({ ...auth, grants: [grant] }).grants).toEqual([grant]);
    for (const invalid of [
      { ...grant, appId: "com.apple.Safari" },
      { ...grant, allowTyping: true },
    ])
      expect(authority.validate({ ...auth, grants: [invalid] }).grants).toEqual([]);
    expect(authority.remembered("other", "p", [grant])).toEqual([]);
    expect(authority.remembered("profile", "other", [grant])).toEqual([]);
  });
  it("keeps session approvals within the generation and remembered approvals across backend restart", () => {
    const authority = new ComputerGrantAuthority("darwin");
    const session = approve(authority, false);
    expect(
      authority.validate({ ...auth, sessionGeneration: "new", grants: [session] }).grants,
    ).toEqual([]);
    const remembered = approve(authority);
    authority.disconnect("profile");
    expect(authority.remembered("profile", "p", [remembered, session])).toEqual([remembered]);
  });
  it("cannot replay a receipt revoked in the same session", () => {
    const authority = new ComputerGrantAuthority("darwin");
    const grant = approve(authority);
    authority.validate({ ...auth, grants: [grant] });
    authority.validate(auth);
    expect(authority.validate({ ...auth, grants: [grant] }).grants).toEqual([]);
    const fresh = approve(authority);
    expect(authority.validate({ ...auth, grants: [fresh] }).grants).toEqual([fresh]);
  });
});

it("cannot restore a forgotten project receipt from the grants file", () => {
  const authority = new ComputerGrantAuthority("darwin");
  const grant = approve(authority);
  authority.validate({ ...auth, grants: [grant] });
  authority.forget("profile", "p", grant.appId);
  expect(authority.remembered("profile", "p", [grant])).toEqual([]);
  expect(authority.validate({ ...auth, grants: [grant] }).grants).toEqual([grant]);
  expect(
    authority.validate({ ...auth, sessionGeneration: "future", grants: [grant] }).grants,
  ).toEqual([]);
});
