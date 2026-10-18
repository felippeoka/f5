import { describe, expect, it } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});

it("bounds setup errors but preserves scrubbed runtime diagnostics", () => {
  const error = EffectAcpErrors.AcpRequestError.authRequired("Usage limit: secret");
  const scrub = (value: string) => value.replaceAll("secret", "[redacted]");
  expect(
    mapAcpToAdapterError("cursor", "t" as never, "session/new", error, scrub).message,
  ).toContain("ACP_REQUEST_FAILED (-32000)");
  expect(
    mapAcpToAdapterError("cursor", "t" as never, "session/prompt", error, scrub).message,
  ).toContain("Usage limit: [redacted]");
});
