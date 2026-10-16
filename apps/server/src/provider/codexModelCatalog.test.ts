import { CodexControlClient } from "../codex/CodexControlClient";
import { readCodexModelPages } from "../codex/readCodexModelPages";
import { describe, expect, it, vi } from "vitest";

import { buildCodexTurnStartParams, readCodexAccountSnapshot } from "../codexAppServerManager.ts";
import {
  probeCodexInstanceCatalog,
  parseCodexInstanceSkills,
  parseCodexModelList,
  readCodexReportedModelCapabilities,
} from "./codexModelCatalog.ts";

const MODEL_LIST = {
  data: [
    {
      id: "gpt-cli-only",
      model: "gpt-cli-only",
      displayName: "CLI Only",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "" },
        { reasoningEffort: "ultra", description: "" },
      ],
      defaultReasoningEffort: "low",
      serviceTiers: [{ id: "fast", name: "Fast" }],
      additionalSpeedTiers: ["turbo"],
      upgrade: "gpt-cli-next",
    },
    { id: "gpt-hidden", model: "gpt-hidden", hidden: true },
  ],
};

describe("parseCodexModelList", () => {
  it("drops hidden models and keeps reported capabilities", () => {
    const { models, presentSlugs } = parseCodexModelList(MODEL_LIST.data);
    expect(presentSlugs).toEqual(["gpt-cli-only", "gpt-hidden"]);
    expect(models.map((model) => model.slug)).toEqual(["gpt-cli-only"]);
    expect(models[0]?.name).toBe("CLI Only");
    expect(models[0]?.capabilities.source).toBe("reported");
    expect(models[0]?.capabilities.upgradeTo).toBe("gpt-cli-next");
    expect(models[0]?.capabilities.serviceTiers?.map((tier) => tier.id)).toEqual(["fast"]);
  });
});

describe("CLI-only model execution", () => {
  it("sends the reported effort on turn/start instead of the built-in fallback", () => {
    const params = buildCodexTurnStartParams(
      { threadId: "thread-1", input: "hello", model: "gpt-cli-only", effort: "ultra" } as never,
      {
        providerThreadId: "provider-thread-1",
        account: readCodexAccountSnapshot({ type: "chatgpt", planType: "pro" }),
        reportedModelCapabilities: readCodexReportedModelCapabilities(MODEL_LIST),
      },
    );
    expect(params.model).toBe("gpt-cli-only");
    expect(params.effort).toBe("ultra");
  });

  it("walks down to a reported effort when the requested one is not offered", () => {
    const params = buildCodexTurnStartParams(
      { threadId: "thread-1", input: "hello", model: "gpt-cli-only", effort: "medium" } as never,
      {
        providerThreadId: "provider-thread-1",
        account: readCodexAccountSnapshot({ type: "chatgpt", planType: "pro" }),
        reportedModelCapabilities: readCodexReportedModelCapabilities(MODEL_LIST),
      },
    );
    expect(params.effort).toBe("low");
  });
});

describe("reported service tiers at turn/start", () => {
  const noFastTier = {
    data: [
      {
        id: "gpt-no-fast",
        model: "gpt-no-fast",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        serviceTiers: [{ id: "flex", name: "Flex" }],
      },
    ],
  };

  it("clears a persisted fast tier the model does not offer", () => {
    const params = buildCodexTurnStartParams(
      { threadId: "thread-1", input: "hello", model: "gpt-no-fast", serviceTier: "fast" } as never,
      {
        providerThreadId: "provider-thread-1",
        account: readCodexAccountSnapshot({ type: "chatgpt", planType: "pro" }),
        reportedModelCapabilities: readCodexReportedModelCapabilities(noFastTier),
      },
    );
    expect(params.serviceTier).toBeNull();
  });

  it("keeps the fast tier when the model reports it", () => {
    const params = buildCodexTurnStartParams(
      { threadId: "thread-1", input: "hello", model: "gpt-cli-only", serviceTier: "fast" } as never,
      {
        providerThreadId: "provider-thread-1",
        account: readCodexAccountSnapshot({ type: "chatgpt", planType: "pro" }),
        reportedModelCapabilities: readCodexReportedModelCapabilities(MODEL_LIST),
      },
    );
    expect(params.serviceTier).toBe("fast");
  });
});

describe("parseCodexInstanceSkills", () => {
  it("keeps instance skills and leaves repo skills to the project scan", () => {
    expect(
      parseCodexInstanceSkills([
        {
          cwd: "/repo",
          skills: [
            { name: "mine", path: "/home/.codex/skills/mine/SKILL.md", scope: "user" },
            { name: "shared", path: "/repo/.codex/skills/shared/SKILL.md", scope: "repo" },
          ],
        },
      ]).map((skill) => skill.name),
    ).toEqual(["mine"]);
  });
});

it("translates the reported priority tier at turn start", () => {
  const reportedModelCapabilities = readCodexReportedModelCapabilities({
    data: [{ model: "gpt-new", serviceTiers: [{ id: "priority" }] }],
  });
  const params = buildCodexTurnStartParams(
    { threadId: "thread-1", input: "hello", model: "gpt-new", serviceTier: "fast" } as never,
    {
      providerThreadId: "provider-thread-1",
      account: readCodexAccountSnapshot({ type: "apiKey" }),
      reportedModelCapabilities,
    },
  );
  expect(params.serviceTier).toBe("priority");
});

it("keeps useful discovery pages and distinguishes failed skills from empty skills", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      data: [{ model: "gpt-fresh", supportedReasoningEfforts: [], serviceTiers: [] }],
      nextCursor: "more",
    })
    .mockRejectedValueOnce(new Error("offline"));
  const closeAndWait = vi.fn(async () => {});
  const fake = {
    listModelPages: () => readCodexModelPages(request),
    listSkills: vi.fn().mockRejectedValue(new Error("offline")),
    closeAndWait,
  };
  const create = vi
    .spyOn(CodexControlClient, "create")
    .mockResolvedValue(fake as unknown as CodexControlClient);
  try {
    const partial = await probeCodexInstanceCatalog({ cwd: process.cwd() });
    expect(partial.complete).toBe(false);
    expect(partial.models[0]?.slug).toBe("gpt-fresh");
    expect(partial.models[0]?.capabilities.supportsEffort).toBe(false);
    expect(partial.skills).toBeUndefined();
    expect(closeAndWait).toHaveBeenCalledTimes(1);
    request.mockReset().mockResolvedValue({ data: [{ model: "gpt-fresh" }], nextCursor: null });
    fake.listSkills.mockResolvedValue([]);
    const empty = await probeCodexInstanceCatalog({ cwd: process.cwd() });
    expect(empty.skills).toEqual([]);
  } finally {
    create.mockRestore();
  }
});
