import { createFileRoute } from "@tanstack/react-router";

import { AppTitlebar } from "../components/AppTitlebar";
import { BotsWorkspace } from "../components/bots/BotsWorkspace";
import { SidebarInset } from "../components/ui/sidebar";

interface BotsSearch {
  task?: string;
  /** Opens "New task" pre-filled from this thread. */
  fromThread?: string;
}

function BotsRouteView() {
  const { task, fromThread } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <AppTitlebar webVisibility="mobile-only" breadcrumb={[{ label: "Bots" }]} />
      <div className="min-h-0 flex-1">
        <BotsWorkspace
          selectedTaskId={task ?? null}
          onSelectTask={(taskId) =>
            void navigate({ search: taskId ? { task: taskId } : {}, replace: true })
          }
          newTaskFromThread={fromThread ?? null}
          onNewTaskDialogClosed={() =>
            void navigate({ search: task ? { task } : {}, replace: true })
          }
        />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/bots")({
  validateSearch: (search: Record<string, unknown>): BotsSearch => ({
    ...(typeof search.task === "string" ? { task: search.task } : {}),
    ...(typeof search.fromThread === "string" ? { fromThread: search.fromThread } : {}),
  }),
  component: BotsRouteView,
});
