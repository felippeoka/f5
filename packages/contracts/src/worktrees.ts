import { GitCheckoutConflict } from "./git";
import { Schema } from "effect";
import { FilesystemPath, NonNegativeInt, ProjectId, ThreadId } from "./baseSchemas";

export const WorktreesInspectInput = Schema.Struct({ projectId: ProjectId, path: FilesystemPath });
export type WorktreesInspectInput = typeof WorktreesInspectInput.Type;
export const WorktreeRegistration = Schema.Struct({
  path: FilesystemPath,
  canonicalPath: FilesystemPath,
  headSha: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  bare: Schema.Boolean,
  detached: Schema.Boolean,
  locked: Schema.NullOr(Schema.String),
  prunable: Schema.NullOr(Schema.String),
  isMain: Schema.Boolean,
});
export const WorktreesInspectResult = Schema.Struct({
  exists: Schema.Boolean,
  registration: Schema.NullOr(WorktreeRegistration),
  blockedReasons: Schema.Array(Schema.String),
  linkedThreads: Schema.Array(
    Schema.Struct({ threadId: ThreadId, title: Schema.String, archived: Schema.Boolean }),
  ),
  deletedThreadClaims: Schema.Array(ThreadId),
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  branchExists: Schema.Boolean,
  branchMerged: Schema.Boolean,
  branchPushed: Schema.Boolean,
  branchUpstreamGone: Schema.Boolean,
  branchDeletable: Schema.Boolean,
  branchBlockedReason: Schema.NullOr(Schema.String),
});
export type WorktreesInspectResult = typeof WorktreesInspectResult.Type;
export const WorktreesRemoveInput = Schema.Struct({
  ...WorktreesInspectInput.fields,
  deleteBranch: Schema.Boolean,
  expectedHead: Schema.NullOr(Schema.String),
});
export type WorktreesRemoveInput = typeof WorktreesRemoveInput.Type;
export const WorktreesRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  branchDeleted: Schema.Boolean,
  blockedReasons: Schema.Array(Schema.String),
});
export type WorktreesRemoveResult = typeof WorktreesRemoveResult.Type;
export const WorktreesThreadStateInput = Schema.Struct({ threadId: ThreadId });
export type WorktreesThreadStateInput = typeof WorktreesThreadStateInput.Type;
export const WorktreesThreadStateResult = Schema.Struct({
  recovery: Schema.optional(Schema.Literals(["none", "running", "interrupted"])),
  worktreePath: Schema.NullOr(FilesystemPath),
  branch: Schema.NullOr(Schema.String),
  directoryExists: Schema.Boolean,
  registration: Schema.Literals(["none", "matching", "stale", "otherBranch"]),
  branchExists: Schema.Boolean,
  defaultBranch: Schema.NullOr(Schema.String),
});
export type WorktreesThreadStateResult = typeof WorktreesThreadStateResult.Type;
export const WorktreesRecoverInput = Schema.Struct({
  threadId: ThreadId,
  expectedQueueRevision: NonNegativeInt,
  action: Schema.Literals(["recreate", "recreateFromBase", "useProjectCheckout", "cancel"]),
});
export type WorktreesRecoverInput = typeof WorktreesRecoverInput.Type;
export const WorktreesRecoverResult = WorktreesThreadStateResult;
export type WorktreesRecoverResult = typeof WorktreesRecoverResult.Type;

export const WorkspaceTransitionIntent = Schema.Literals([
  "attach_existing",
  "checkout_branch",
  "create_branch_and_checkout",
  "use_project_checkout",
  "recreate",
  "recreate_from_base",
]);
export const WorkspaceTransitionPhase = Schema.Literals([
  "reserved",
  "stopping",
  "applying",
  "applied",
  "needs_recovery",
  "completed",
  "failed",
  "cancelled",
]);
export const WorkspaceExpectedContext = Schema.Struct({
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(FilesystemPath),
  sessionUpdatedAt: Schema.NullOr(Schema.String),
});
export const WorktreesSwitchWorkspaceInput = Schema.Struct({
  operationId: Schema.NonEmptyString.check(Schema.isMaxLength(200)),
  threadId: ThreadId,
  expected: WorkspaceExpectedContext,
  intent: WorkspaceTransitionIntent,
  targetPath: Schema.optional(FilesystemPath),
  branch: Schema.optional(Schema.NonEmptyString),
  sharedFilesystemConfirmed: Schema.optional(Schema.Boolean),
});
export type WorktreesSwitchWorkspaceInput = typeof WorktreesSwitchWorkspaceInput.Type;
export const WorkspaceCheckoutIdentity = Schema.Struct({
  path: FilesystemPath,
  repository: FilesystemPath,
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
});
export type WorkspaceCheckoutIdentity = typeof WorkspaceCheckoutIdentity.Type;
export const WorkspaceTransitionSnapshot = Schema.Struct({
  checkoutConflict: Schema.optional(GitCheckoutConflict),
  operationId: Schema.String,
  threadId: ThreadId,
  version: NonNegativeInt,
  intent: WorkspaceTransitionIntent,
  phase: WorkspaceTransitionPhase,
  source: WorkspaceCheckoutIdentity,
  target: WorkspaceCheckoutIdentity,
  observed: Schema.NullOr(WorkspaceCheckoutIdentity),
  error: Schema.NullOr(Schema.String),
  result: Schema.NullOr(WorkspaceExpectedContext),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type WorkspaceTransitionSnapshot = typeof WorkspaceTransitionSnapshot.Type;
export const WorktreesGetTransitionInput = WorktreesThreadStateInput;
export type WorktreesGetTransitionInput = typeof WorktreesGetTransitionInput.Type;
export const WorktreesGetTransitionResult = Schema.NullOr(WorkspaceTransitionSnapshot);
export const WorktreesPreviewTransitionRecoveryInput = Schema.Struct({
  operationId: Schema.String,
});
export type WorktreesPreviewTransitionRecoveryInput =
  typeof WorktreesPreviewTransitionRecoveryInput.Type;
export const WorkspaceTransitionRecoveryPreview = Schema.Struct({
  transition: WorkspaceTransitionSnapshot,
  actual: Schema.NullOr(WorkspaceCheckoutIdentity),
  original: Schema.NullOr(WorkspaceCheckoutIdentity),
  acceptanceToken: Schema.String,
  canRetry: Schema.Boolean,
  blockedReasons: Schema.Array(Schema.String),
});
export type WorkspaceTransitionRecoveryPreview = typeof WorkspaceTransitionRecoveryPreview.Type;
export const WorktreesResolveTransitionInput = Schema.Struct({
  operationId: Schema.String,
  version: NonNegativeInt,
  acceptanceToken: Schema.String,
  action: Schema.Literals(["accept_inspected_workspace", "keep_original_workspace", "retry"]),
});
export type WorktreesResolveTransitionInput = typeof WorktreesResolveTransitionInput.Type;
