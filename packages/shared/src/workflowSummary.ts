/** Projection and client summaries share the same omission rules. Generics also
 * accept encoded repository rows without throwing away their decoded brands. */
export function summarizePlanningWorkflow<
  T extends {
    requirementPrompt: string;
    plansDirectory: string;
    implementation?: { reviewArtifact?: unknown } | null | undefined;
  },
>(
  workflow: T,
): Omit<T, "requirementPrompt" | "plansDirectory" | "implementation"> & {
  implementation: Omit<NonNullable<T["implementation"]>, "reviewArtifact"> | null;
} {
  const {
    requirementPrompt: _prompt,
    plansDirectory: _directory,
    implementation,
    ...summary
  } = workflow;
  if (!implementation) return { ...summary, implementation: null };
  const { reviewArtifact: _artifact, ...stage } = implementation;
  return {
    ...summary,
    implementation: stage as Omit<NonNullable<T["implementation"]>, "reviewArtifact">,
  };
}
export function summarizeCodeReviewWorkflow<T extends { reviewPrompt: string }>({
  reviewPrompt: _prompt,
  ...summary
}: T) {
  return summary;
}
export function summarizeInvestigationWorkflow<T extends { problemPrompt: string }>({
  problemPrompt: _prompt,
  ...summary
}: T) {
  return summary;
}
