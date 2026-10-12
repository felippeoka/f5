import { ApprovalRequestId, ThreadId, TurnId, type PendingUserInput } from "@t3tools/contracts";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncUserInputPanel } from "./AsyncUserInputPanel";
const mocks = vi.hoisted(() => ({ dispatch: vi.fn(), release: vi.fn() }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: { dispatchCommand: mocks.dispatch },
    attachments: { releaseUploads: mocks.release },
  }),
}));
const threadId = ThreadId.makeUnsafe("questions-thread");
const question: PendingUserInput = {
  requestId: ApprovalRequestId.makeUnsafe("question-1"),
  turnId: TurnId.makeUnsafe("finished-turn"),
  createdAt: "2026-09-30T12:00:00.000Z",
  responseMode: "message",
  questions: [
    {
      id: "0",
      header: "Tools",
      question: "Choose tools",
      options: [
        { label: "A", description: "First" },
        { label: "B", description: "Second" },
      ],
      multiSelect: true,
    },
  ],
};
const twoQuestions: PendingUserInput = {
  ...question,
  requestId: ApprovalRequestId.makeUnsafe("question-2"),
  questions: [
    {
      id: "retry",
      header: "Retry",
      question: "Repeat the check?",
      options: [
        { label: "Ready", description: "Run it now" },
        { label: "Later", description: "Save it for later" },
      ],
    },
    {
      id: "dialog",
      header: "Dialog",
      question: "Did a dialog open?",
      options: [
        { label: "No", description: "Nothing appeared" },
        { label: "Yes", description: "Something opened" },
      ],
    },
  ],
};
describe("async questions", () => {
  beforeEach(() => {
    mocks.dispatch.mockReset().mockResolvedValue({ sequence: 1 });
    mocks.release.mockReset().mockResolvedValue(undefined);
  });
  it("preserves multiple selected choices and typed answers in one response", async () => {
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={question} />);
    try {
      await page.getByRole("button", { name: "A", exact: true }).click();
      await page.getByRole("button", { name: "B", exact: true }).click();
      await page.getByRole("button", { name: "Other…" }).click();
      await page.getByRole("textbox", { name: "Other answer: Choose tools" }).fill("Typed detail");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.user-input.respond",
          requestId: question.requestId,
          answers: { "0": { answers: ["A", "B", "Typed detail"] } },
        }),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("steps through questions without auto-sending the last one", async () => {
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={twoQuestions} />);
    try {
      await expect.element(page.getByText("1/2")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "Ready", exact: true }).click();
      await expect.element(page.getByText("Did a dialog open?")).toBeVisible();
      await expect.element(page.getByText("2/2")).toBeVisible();
      await page.getByRole("button", { name: "Go to previous question" }).click();
      await expect.element(page.getByText("Repeat the check?")).toBeVisible();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByRole("button", { name: "No", exact: true }).click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(mocks.dispatch).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.user-input.respond",
          answers: { retry: { answers: ["Ready"] }, dialog: { answers: ["No"] } },
        }),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("scopes digit shortcuts to the focused panel", async () => {
    const screen = await render(
      <div>
        <textarea aria-label="Composer" />
        <AsyncUserInputPanel threadId={threadId} input={question} />
      </div>,
    );
    try {
      await page.getByRole("textbox", { name: "Composer" }).click();
      await userEvent.keyboard("2");
      await expect
        .element(page.getByRole("button", { name: "B", exact: true }))
        .toHaveAttribute("aria-pressed", "false");
      await page.getByRole("button", { name: "A", exact: true }).click();
      await userEvent.keyboard("2");
      await expect
        .element(page.getByRole("button", { name: "B", exact: true }))
        .toHaveAttribute("aria-pressed", "true");
    } finally {
      await screen.unmount();
    }
  });
  it("answers option-free questions in free text", async () => {
    const freeText: PendingUserInput = {
      ...question,
      questions: [{ id: "why", header: "Reason", question: "Why?", options: [] }],
    };
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={freeText} />);
    try {
      await page.getByRole("textbox", { name: "Other answer: Why?" }).fill("Because");
      await userEvent.keyboard("{Enter}");
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ answers: { why: { answers: ["Because"] } } }),
      );
    } finally {
      await screen.unmount();
    }
  });
  it("keeps the answer editable after a failed submission", async () => {
    mocks.dispatch.mockRejectedValueOnce(new Error("Offline"));
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={question} />);
    try {
      await page.getByRole("button", { name: "Other…" }).click();
      await page.getByRole("textbox").fill("Keep my draft");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("Offline");
      await expect.element(page.getByRole("textbox")).toHaveValue("Keep my draft");
    } finally {
      await screen.unmount();
    }
  });
  it("dismisses a question without submitting an answer", async () => {
    const screen = await render(<AsyncUserInputPanel threadId={threadId} input={question} />);
    try {
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      expect(mocks.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "thread.user-input.dismiss",
          requestId: question.requestId,
        }),
      );
      expect(mocks.dispatch.mock.calls[0]?.[0]).not.toHaveProperty("answers");
    } finally {
      await screen.unmount();
    }
  });
});
