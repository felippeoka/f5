import { isAbsolute, win32 } from "node:path";
import { createHash } from "node:crypto";
import { TurnId, type ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { piRecordField, piRecordString, type PiRpcRecord } from "./PiProtocol.ts";
import { PiRpcError } from "./PiRpc.ts";
import { parsePiSessionTree, piActiveBranch } from "./PiSessionTree.ts";

export interface PiBoundary {
  readonly turnId: string;
  readonly entryId: string;
}
export interface PiResumeCursor {
  readonly schemaVersion: 1;
  readonly sessionFile: string;
  readonly leafId: string | null;
  readonly boundaries: readonly PiBoundary[];
  readonly rewindSourceThreadId?: string;
  readonly rewindBeforeTurnId?: string;
  readonly rewindRetainedHash?: string;
}
export function parsePiResumeCursor(value: unknown): PiResumeCursor | undefined {
  const file = piRecordString(value, "sessionFile");
  const leafId = piRecordField(value, "leafId");
  const boundaries = piRecordField(value, "boundaries");
  if (
    piRecordField(value, "schemaVersion") !== 1 ||
    !file ||
    file.length > 16_384 ||
    file.includes("\0") ||
    (!isAbsolute(file) && !win32.isAbsolute(file)) ||
    (leafId !== null &&
      (typeof leafId !== "string" ||
        !leafId.trim() ||
        leafId.trim() !== leafId ||
        leafId.length > 1024 ||
        leafId.includes("\0"))) ||
    !Array.isArray(boundaries) ||
    boundaries.length > 500
  )
    return undefined;
  const parsed: PiBoundary[] = [];
  const turns = new Set<string>(),
    entries = new Set<string>();
  for (const boundary of boundaries) {
    const turnId = piRecordString(boundary, "turnId"),
      entryId = piRecordString(boundary, "entryId");
    if (
      !turnId ||
      !entryId ||
      turnId.trim() !== turnId ||
      entryId.trim() !== entryId ||
      turnId.includes("\0") ||
      entryId.includes("\0") ||
      turnId.length > 1024 ||
      entryId.length > 1024 ||
      turns.has(turnId) ||
      entries.has(entryId)
    )
      return undefined;
    turns.add(turnId);
    entries.add(entryId);
    parsed.push({ turnId, entryId });
  }
  const rewindSourceThreadId = piRecordString(value, "rewindSourceThreadId");
  const rewindBeforeTurnId = piRecordString(value, "rewindBeforeTurnId");
  const rewindRetainedHash = piRecordString(value, "rewindRetainedHash");
  if (rewindRetainedHash !== undefined && !/^[a-f0-9]{64}$/.test(rewindRetainedHash))
    return undefined;
  if (
    rewindSourceThreadId !== undefined &&
    ((!isAbsolute(rewindSourceThreadId) && !win32.isAbsolute(rewindSourceThreadId)) ||
      rewindSourceThreadId.includes("\0") ||
      rewindSourceThreadId.length > 16384)
  )
    return undefined;
  if (
    rewindBeforeTurnId !== undefined &&
    (!rewindBeforeTurnId.trim() || rewindBeforeTurnId.length > 1024)
  )
    return undefined;
  return {
    schemaVersion: 1,
    sessionFile: file,
    leafId,
    boundaries: parsed,
    ...(rewindSourceThreadId ? { rewindSourceThreadId } : {}),
    ...(rewindBeforeTurnId ? { rewindBeforeTurnId } : {}),
    ...(rewindRetainedHash ? { rewindRetainedHash } : {}),
  };
}

/** Responses are delivered by the native event pump so preceding lifecycle events cannot be skipped. */
export type PiHistoryRequest = (record: PiRpcRecord) => Effect.Effect<unknown, PiRpcError>;
export const piHistoryBoundaryHash = (ids: readonly string[]): string =>
  createHash("sha256").update(JSON.stringify(ids)).digest("hex");

export const readPiHistory = (input: {
  readonly threadId: ThreadId;
  readonly cursor: PiResumeCursor;
  readonly request: PiHistoryRequest;
}) =>
  Effect.gen(function* () {
    const error = (detail: string) => new PiRpcError({ operation: "history", detail });
    const initial = yield* input.request({ type: "get_state" });
    if (
      piRecordString(initial, "sessionFile") !== input.cursor.sessionFile ||
      piRecordField(initial, "isStreaming") !== false
    )
      return yield* error("Pi history changed sessions or is still running.");
    const tree = parsePiSessionTree(yield* input.request({ type: "get_entries" }));
    const branch = tree ? piActiveBranch(tree) : null;
    if (!tree || !branch) return yield* error("Pi history has incomplete or cyclic ancestry.");
    // get_messages is the active context; get_entries alone also contains abandoned branches.
    const data = yield* input.request({ type: "get_messages" });
    const messages = piRecordField(data, "messages");
    if (!Array.isArray(messages) || messages.length > 20_000)
      return yield* error("Pi did not return a bounded active message history.");
    const after = parsePiSessionTree(yield* input.request({ type: "get_entries" }));
    const afterBranch = after ? piActiveBranch(after) : null;
    const final = yield* input.request({ type: "get_state" });
    if (
      !after ||
      !afterBranch ||
      tree.leafId !== after.leafId ||
      branch.length !== afterBranch.length ||
      branch.some((entry, index) => entry.id !== afterBranch[index]?.id) ||
      piRecordString(final, "sessionFile") !== input.cursor.sessionFile ||
      piRecordField(final, "isStreaming") !== false
    )
      return yield* error("Pi history changed during the snapshot.");
    const users = branch.filter((entry) => entry.user).map((entry) => entry.id);
    const nativeUserCount = messages.filter(
      (message) => piRecordString(message, "role") === "user",
    ).length;
    if (nativeUserCount > users.length)
      return yield* error("Pi messages do not match their persisted branch boundaries.");
    const known = new Map(
      input.cursor.boundaries.map((boundary) => [boundary.entryId, boundary.turnId]),
    );
    const items = new Map(users.map((id) => [id, [] as unknown[]]));
    let userIndex = users.length - nativeUserCount - 1;
    for (const [index, message] of messages.entries()) {
      const role = piRecordString(message, "role");
      if (role !== "user" && role !== "assistant") continue;
      if (role === "user") userIndex++;
      const id = users[userIndex];
      if (!id) continue;
      items.get(id)!.push({
        id: `${id}:message:${index}`,
        type: role === "user" ? "userMessage" : "agentMessage",
        role,
        content: piRecordField(message, "content"),
      });
    }
    const snapshot: ProviderThreadSnapshot = {
      threadId: input.threadId,
      history: {
        identity: input.cursor.sessionFile,
        provenance: "provider-persisted",
        coverage: "complete",
        boundary: tree.leafId,
        runtimeId: null,
      },
      turns: users.map((id) => ({ id: TurnId.make(known.get(id) ?? id), items: items.get(id)! })),
    };
    return { snapshot, tree, userEntryIds: users };
  });
