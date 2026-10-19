export type IgnoredFilesRemovalPolicy =
  | { readonly kind: "protect" }
  | {
      readonly kind: "manual";
      readonly approvedEntries?: ReadonlyArray<string> | undefined;
    };

/** Approval covers exactly the listed file or directory, never other paths. */
export function blockingIgnoredEntries(
  entries: ReadonlyArray<string>,
  policy: IgnoredFilesRemovalPolicy = { kind: "protect" },
): ReadonlyArray<string> {
  const approved = new Set(policy.kind === "manual" ? policy.approvedEntries : []);
  return entries.filter(
    (entry) =>
      !approved.has(entry) && (policy.kind === "manual" || !/(^|\/)node_modules\/?$/.test(entry)),
  );
}
