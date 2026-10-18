import { describe, expect, it } from "vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { isMcpQueryAffected, mcpQueryKeys } from "./mcpReactQuery";

describe("MCP status event scoping", () => {
  it("invalidates only the named account when an instance is stamped", () => {
    const project = ProjectId.makeUnsafe("project");
    const work = ProviderInstanceId.make("work");
    const event = {
      scope: "project" as const,
      projectId: project,
      instanceId: work,
      reason: "applied" as const,
    };
    expect(
      isMcpQueryAffected(mcpQueryKeys.serverStatuses("codex", project, work, null), event),
    ).toBe(true);
    expect(
      isMcpQueryAffected(mcpQueryKeys.serverStatuses("codex", project, "personal", null), event),
    ).toBe(false);
    expect(isMcpQueryAffected(mcpQueryKeys.codexStatus(project, work, null), event)).toBe(true);
    expect(isMcpQueryAffected(mcpQueryKeys.oauthStatus(project, "docs", work, null), event)).toBe(
      true,
    );
    expect(isMcpQueryAffected(mcpQueryKeys.commonConfig(), event)).toBe(false);
    expect(
      isMcpQueryAffected(
        mcpQueryKeys.serverStatuses("codex", ProjectId.makeUnsafe("other"), work, null),
        event,
      ),
    ).toBe(false);
    const { instanceId: _, ...unscoped } = event;
    expect(
      isMcpQueryAffected(mcpQueryKeys.serverStatuses("codex", project, "personal", null), unscoped),
    ).toBe(true);
  });
});
