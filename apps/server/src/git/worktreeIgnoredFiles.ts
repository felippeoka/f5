/** Approval covers exactly the listed file or directory, never other paths. */
export function blockingIgnoredEntries(
  entries: ReadonlyArray<string>,
  approvedEntries?: ReadonlyArray<string>,
  requireApproval = false,
): ReadonlyArray<string> {
  const approved = new Set(approvedEntries);
  return entries.filter(
    (entry) =>
      !approved.has(entry) &&
      (requireApproval || approvedEntries !== undefined || !/(^|\/)node_modules\/?$/.test(entry)),
  );
}
