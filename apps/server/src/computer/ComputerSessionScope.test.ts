import { describe, expect, it } from "vitest";
import { computerHostFixture } from "../../integration/computer/hostFixture";
import { createComputerSessionScope } from "./ComputerSessionScope";

describe("shared computer session scope", () => {
  it("clears geometry and rejects stale finalizers without releasing a replacement generation", async () => {
    const fixture = await computerHostFixture();
    const threadId = "scope-thread";
    try {
      const first = createComputerSessionScope({
        broker: fixture.broker,
        threadId,
        provider: "codex",
        serverName: "scope-first",
      });
      const oldGeometry = first.geometry;
      first.resetConnection();
      expect(first.geometry).not.toBe(oldGeometry);
      const second = createComputerSessionScope({
        broker: fixture.broker,
        threadId,
        provider: "codex",
        serverName: "scope-second",
      });
      first.dispose();
      first.dispose();
      first.endTurn("test-turn");
      expect(fixture.broker.generation(threadId)).toBe(second.generation);
      second.dispose();
      expect(fixture.broker.generation(threadId)).toBeUndefined();
    } finally {
      fixture.broker.close();
    }
  });
  it("refuses new identities on a legacy desktop without impersonating another agent", async () => {
    const fixture = await computerHostFixture();
    try {
      // The fixture is a legacy desktop unless it explicitly negotiates capabilities.
      expect(() =>
        createComputerSessionScope({
          broker: fixture.broker,
          threadId: "cursor-thread",
          provider: "cursor",
          serverName: "scope-cursor",
        }),
      ).toThrow("Update F5");
      expect(fixture.broker.generation("cursor-thread")).toBeUndefined();
    } finally {
      fixture.broker.close();
    }
  });
});
