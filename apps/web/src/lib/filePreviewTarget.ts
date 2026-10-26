import { looksLikeAbsoluteFilePath } from "./normalizeFilePathForDiff";

export interface FilePreviewTarget {
  cwd: string;
  relativePath: string;
  readOnly: boolean;
}

/**
 * Keep the displayed path intact while adapting local references to the existing
 * bounded read RPC. Its server-side realpath containment and size limits still
 * apply. External references never become editable workspace entries.
 */
export function resolveFilePreviewTarget(
  filePath: string | undefined,
  workspaceRoot: string | undefined,
): FilePreviewTarget | undefined {
  if (!filePath) return;
  if (!looksLikeAbsoluteFilePath(filePath)) {
    return workspaceRoot
      ? { cwd: workspaceRoot, relativePath: filePath, readOnly: false }
      : undefined;
  }
  const path = filePath.replaceAll("\\", "/");
  // Network shares are not local file previews.
  if (path.startsWith("//")) return;
  const separator = path.lastIndexOf("/");
  const relativePath = path.slice(separator + 1);
  if (!relativePath || relativePath === "." || relativePath === "..") return;
  const parent = path.slice(0, separator + 1);
  const cwd = parent === "/" || /^[a-z]:\/$/iu.test(parent) ? parent : parent.slice(0, -1);
  return { cwd, relativePath, readOnly: true };
}
