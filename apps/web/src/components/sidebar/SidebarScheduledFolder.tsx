import type { ThreadId } from "@t3tools/contracts";
import { ChevronRightIcon, CircleAlertIcon, FolderClockIcon, LoaderIcon } from "lucide-react";

import { isSnoozedThread } from "../../lib/threadOrdering";
import { cn } from "../../lib/utils";
import type { ThreadListItem } from "../../types";
import { SIDEBAR_TREE_LEVEL_CLASS_NAME } from "../Sidebar.logic";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "../ui/sidebar";
import { SidebarThreadRow } from "./SidebarThreadRow";
import type { SidebarThreadRowIndicators } from "./SidebarWorkflowItem";
import type { SidebarThreadActions } from "./useSidebarThreadActions";

export function SidebarScheduledFolder(props: {
  threads: readonly ThreadListItem[];
  visibleThreads: readonly ThreadListItem[];
  expanded: boolean;
  showingAll: boolean;
  previewLimit: number;
  onToggle: () => void;
  onToggleShowAll: () => void;
  routeThreadId: ThreadId | null;
  orderedIds: readonly ThreadId[];
  indicatorsForThread: (thread: ThreadListItem) => SidebarThreadRowIndicators;
  actions: SidebarThreadActions;
}) {
  let attention = 0;
  let running = 0;
  let unread = 0;
  for (const thread of props.threads) {
    if (thread.archivedAt !== null || isSnoozedThread(thread)) continue;
    const indicators = props.indicatorsForThread(thread);
    if (indicators.isUnread) unread++;
    const status = indicators.threadStatus;
    if (!status) continue;
    if (["Pending Approval", "Awaiting Input", "Plan Ready"].includes(status.label)) attention++;
    else if (status.pulse) running++;
  }

  return (
    <SidebarMenuSubItem className="w-full" data-testid="scheduled-thread-folder">
      <SidebarMenuSubButton
        render={<button type="button" />}
        data-thread-selection-safe
        aria-label={`Scheduled (${props.threads.length})`}
        aria-expanded={props.expanded}
        className="h-8 w-full translate-x-0 gap-2 rounded-md px-2 text-left"
        onClick={props.onToggle}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-3 shrink-0 transition-transform", props.expanded && "rotate-90")}
        />
        <FolderClockIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1 truncate">Scheduled</span>
        {attention > 0 && (
          <span
            className="flex items-center gap-1 text-attention-foreground"
            title={`${attention} need attention`}
          >
            <CircleAlertIcon aria-hidden="true" className="size-3.5" />
            <span className="sr-only">Needs attention: </span>
            {attention}
          </span>
        )}
        {running > 0 && (
          <span
            className="flex items-center gap-1 text-info-foreground"
            title={`${running} running`}
          >
            <LoaderIcon aria-hidden="true" className="size-3.5 animate-status-pulse" />
            <span className="sr-only">Running: </span>
            {running}
          </span>
        )}
        {unread > 0 && (
          <span className="size-1.5 shrink-0 rounded-full bg-primary" title={`${unread} unread`}>
            <span className="sr-only">Unread: {unread}</span>
          </span>
        )}
        <span className="text-2xs tabular-nums text-muted-foreground">{props.threads.length}</span>
      </SidebarMenuSubButton>
      {props.expanded && (
        <SidebarMenuSub className={SIDEBAR_TREE_LEVEL_CLASS_NAME}>
          {props.visibleThreads.map((thread) => {
            const section =
              thread.archivedAt !== null
                ? "archived"
                : isSnoozedThread(thread)
                  ? "snoozed"
                  : "active";
            const indicators = props.indicatorsForThread(thread);
            return (
              <SidebarThreadRow
                key={thread.id}
                thread={thread}
                section={section}
                isActive={props.routeThreadId === thread.id}
                orderedIds={props.orderedIds}
                isRenaming={props.actions.renamingThreadId === thread.id}
                trailingMeta={
                  section !== "active" ? (
                    <span className="text-2xs text-muted-foreground">
                      {section === "archived" ? "Archived" : "Snoozed"}
                    </span>
                  ) : undefined
                }
                actions={props.actions}
                {...indicators}
                threadStatus={section === "snoozed" ? null : indicators.threadStatus}
              />
            );
          })}
          {props.threads.length > props.previewLimit && (
            <SidebarMenuSubItem>
              <SidebarMenuSubButton
                render={<button type="button" />}
                size="sm"
                data-thread-selection-safe
                onClick={props.onToggleShowAll}
              >
                {props.showingAll ? "Show less" : "Show more"}
              </SidebarMenuSubButton>
            </SidebarMenuSubItem>
          )}
        </SidebarMenuSub>
      )}
    </SidebarMenuSubItem>
  );
}
