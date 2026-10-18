import {
  type ProviderApprovalDecision,
  type ProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import { Schema } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  type ProviderAdapterError,
} from "../Errors.ts";

const setupFailures = new WeakSet<EffectAcpErrors.AcpError>();
export function rememberAcpSetupFailure(error: EffectAcpErrors.AcpError): void {
  setupFailures.add(error);
}

export function mapAcpToAdapterError(
  provider: ProviderKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
  scrubDiagnostic: (value: string) => string = (value) => value,
): ProviderAdapterError {
  const setup =
    ["session/new", "session/load", "session/resume"].includes(method) || setupFailures.has(error);
  const detail = scrubDiagnostic(error.message).slice(0, 2000);
  if (Schema.is(EffectAcpErrors.AcpProcessExitedError)(error)) {
    return new ProviderAdapterProcessError({
      provider,
      threadId,
      detail: setup ? "ACP_PROCESS_EXITED" : detail,
    });
  }
  if (Schema.is(EffectAcpErrors.AcpRequestError)(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: setup ? `ACP_REQUEST_FAILED (${error.code})` : detail,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: setup ? "ACP_TRANSPORT_FAILED" : detail,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}
