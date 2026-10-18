import { useRef } from "react";
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FolderIcon, GitForkIcon } from "lucide-react";
import { openInPreferredEditor } from "../editorPreferences";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { ensureNativeApi } from "../nativeApi";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { useWorktreeRemovalDialogStore } from "../worktreeRemovalDialogStore";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "./ui/menu";
import { toastManager } from "./ui/toast";

export function WorktreeChip({
  threadId,
  projectId,
  branch,
  path,
  isWorktree,
  onOpenTerminal,
  onNewWorktree,
}: {
  threadId: ThreadId;
  projectId: ProjectId;
  branch: string | null;
  path: string;
  isWorktree: boolean;
  onOpenTerminal?: () => void;
  onNewWorktree?: () => void;
}) {
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const run = (action: () => Promise<unknown>) =>
    void action().catch((error) =>
      toastManager.add({
        type: "error",
        title: "Workspace action failed",
        description: String(error),
      }),
    );
  const dir = formatWorktreePathForDisplay(path);
  return (
    <Menu>
      <MenuTrigger
        ref={triggerRef}
        data-composer-control={isWorktree ? undefined : "envMode"}
        className="inline-flex min-w-0 max-w-60 items-center gap-1 rounded px-2 py-1 text-2xs text-muted-foreground hover:text-foreground focus-visible:outline-ring"
        aria-label={`${isWorktree ? "Worktree" : "Local"}: ${branch ?? dir} · ${path}`}
        title={path}
      >
        {isWorktree ? (
          <GitForkIcon className="size-3 shrink-0" />
        ) : (
          <FolderIcon className="size-3 shrink-0" />
        )}
        <span className="truncate">{isWorktree ? `${branch ?? dir} · …/${dir}` : "Local"}</span>
      </MenuTrigger>
      <MenuPopup
        finalFocus={triggerRef}
        align="start"
        className="max-w-[min(32rem,calc(100vw-2rem))]"
      >
        <div className="space-y-1 px-2 py-2 text-xs">
          <p className="break-all font-medium">{branch ?? dir}</p>
          <p className="break-all whitespace-pre-wrap font-mono text-muted-foreground">{path}</p>
        </div>
        <MenuSeparator />
        <MenuItem onClick={() => run(() => writeTextToClipboard(path))}>Copy path</MenuItem>
        <MenuItem onClick={() => run(() => openInPreferredEditor(ensureNativeApi(), path))}>
          Open in editor
        </MenuItem>
        <MenuItem
          onClick={() =>
            run(() =>
              ensureNativeApi().shell.revealInFileManager({
                threadId,
                projectId,
                relativePath: ".",
                kind: "directory",
              }),
            )
          }
        >
          Reveal
        </MenuItem>
        <MenuItem disabled={!onOpenTerminal} onClick={onOpenTerminal}>
          Open terminal here
        </MenuItem>
        <MenuSeparator />
        {onNewWorktree && <MenuItem onClick={onNewWorktree}>New worktree</MenuItem>}
        <MenuItem
          onClick={() => void navigate({ to: "/worktrees", search: { projectId, threadId } })}
        >
          {isWorktree ? "Manage worktrees…" : "Use existing worktree…"}
        </MenuItem>
        {isWorktree && (
          <MenuItem
            variant="destructive"
            onClick={() =>
              void useWorktreeRemovalDialogStore.getState().request([{ projectId, path }])
            }
          >
            Remove worktree…
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}
