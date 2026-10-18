import { AGENT_AUTOMATION_SUPPORT } from "@t3tools/shared/agentAutomationSupport";
import { probeCodexBundledRuntime } from "./codexBundledRuntime";

export interface BuiltinAvailability {
  readonly available: false;
  readonly reason: string;
  readonly version?: string;
  readonly manifestHash?: string;
}

/** Read-only compatibility probe. A bundled plugin's presence is not certification,
 * and it never enables plugins or imports a user's global provider home. */
export async function probeComputerBuiltin(input: {
  provider: "claude" | "codex";
  platform: string;
  chatGptResources?: string;
  read?: (path: string) => Promise<string>;
}): Promise<BuiltinAvailability> {
  if (input.platform !== "darwin")
    return {
      available: false,
      reason: "Provider built-in computer control is unsupported on this platform",
    };
  if (input.provider === "claude")
    return {
      available: false,
      reason: AGENT_AUTOMATION_SUPPORT.claudeAgent.builtin!,
    };
  return probeCodexBundledRuntime({ ...input, capability: "computer" });
}
