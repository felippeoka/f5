import { describe, expect, it, vi } from "vitest";
import type { ComputerAccessAnswer, ComputerAccessRequested } from "@t3tools/contracts";
import { ComputerConsentAuthority } from "./ComputerConsentAuthority";

const request: ComputerAccessRequested = {
  requestId: "r",
  threadId: "t",
  reason: "Edit a document",
  kind: "apps",
  apps: [{ appId: "com.apple.Terminal", name: "Terminal", tier: "click" }],
};
const offered: ComputerAccessAnswer = {
  requestId: "r",
  backendIncarnation: "b",
  decisions: [{ appId: "com.apple.Terminal", allow: true, allowTyping: true, remember: true }],
  allowSessionActions: true,
  allowChromeSetup: true,
};
function make(source = request) {
  const show = vi.fn(async () => ({ response: 0, checkboxChecked: false }));
  const answer = vi.fn();
  const read = vi.fn(() => source);
  const authority = new ComputerConsentAuthority({
    platform: "darwin",
    request: read,
    answer,
    show,
  });
  return { authority, show, answer, read };
}
describe("main-owned computer consent", () => {
  it.each(["view", "full"] as const)(
    "makes %s rights explicit without allowing renderer typing choices",
    async (tier) => {
      const h = make({ ...request, apps: [{ appId: "org.example.App", name: "Example", tier }] });
      h.show.mockResolvedValue({ response: 1, checkboxChecked: false });
      await h.authority.review("profile", offered);
      expect(h.show).toHaveBeenCalledWith(
        "profile",
        expect.objectContaining({
          buttons: ["Deny", tier === "view" ? "Allow viewing" : "Allow control and typing"],
          defaultId: 0,
        }),
      );
      expect(h.answer.mock.calls[0]![1].decisions[0]).toMatchObject({
        allow: true,
        allowTyping: false,
        remember: false,
      });
    },
  );
  it("ignores every renderer allowance even after a trusted unrelated click", async () => {
    const h = make();
    await h.authority.review("profile", offered);
    expect(h.answer).toHaveBeenCalledWith("profile", {
      requestId: "r",
      backendIncarnation: "b",
      decisions: [
        { appId: "com.apple.Terminal", allow: false, allowTyping: false, remember: false },
      ],
    });
    expect(h.show).toHaveBeenCalledWith(
      "profile",
      expect.objectContaining({
        buttons: ["Deny", "Allow clicks", "Allow clicks and typing"],
        defaultId: 0,
        cancelId: 0,
        checkboxChecked: false,
      }),
    );
  });
  it("typing and remembering follow only the native dialog choices", async () => {
    const h = make();
    h.show.mockResolvedValue({ response: 2, checkboxChecked: true });
    await h.authority.review("profile", { ...offered, decisions: [] });
    expect(h.answer.mock.calls[0]![1].decisions).toEqual([
      { appId: "com.apple.Terminal", allow: true, allowTyping: true, remember: true },
    ]);
    h.show.mockResolvedValue({ response: 1, checkboxChecked: false });
    await h.authority.review("profile", offered);
    expect(h.answer.mock.calls[1]![1].decisions[0]).toMatchObject({
      allow: true,
      allowTyping: false,
      remember: false,
    });
  });
  it("does not prompt for or allow a protected app advertised as full", async () => {
    const h = make({
      ...request,
      apps: [{ appId: "com.apple.systempreferences", name: "Settings", tier: "full" }],
    });
    await h.authority.review("profile", offered);
    expect(h.show).not.toHaveBeenCalled();
    expect(h.answer.mock.calls[0]![1].decisions[0]?.allow).toBe(false);
  });
  it("rejects expiry while the dialog is open and prevents duplicate prompts", async () => {
    const h = make();
    let finish: (value: { response: number; checkboxChecked: boolean }) => void = () => {};
    const prompt = new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => {
      finish = resolve;
    });
    h.show.mockReturnValue(prompt);
    const pending = h.authority.review("profile", offered);
    await expect(h.authority.review("profile", offered)).rejects.toThrow("already being reviewed");
    h.read.mockImplementation(() => {
      throw new Error("expired");
    });
    finish({ response: 2, checkboxChecked: true });
    await expect(pending).rejects.toThrow("expired");
    expect(h.answer).not.toHaveBeenCalled();
  });
  it.each(["session-actions", "chrome-setup"] as const)(
    "renderer cannot approve %s",
    async (kind) => {
      const h = make({ ...request, kind, apps: [] });
      await h.authority.review("profile", offered);
      expect(h.answer.mock.calls[0]![1]).toMatchObject(
        kind === "chrome-setup" ? { allowChromeSetup: false } : { allowSessionActions: false },
      );
      expect(h.answer.mock.calls[0]![1].decisions).toEqual([]);
    },
  );
  it("requires independent native confirmation for Resume", async () => {
    const h = make();
    expect(await h.authority.confirmResume("profile", "Trusted thread")).toBe(false);
    h.show.mockResolvedValue({ response: 1, checkboxChecked: false });
    expect(await h.authority.confirmResume("profile", "Trusted thread")).toBe(true);
    expect(h.show).toHaveBeenLastCalledWith(
      "profile",
      expect.objectContaining({
        defaultId: 0,
        cancelId: 0,
        message: "Resume computer control for Trusted thread?",
      }),
    );
  });
});
