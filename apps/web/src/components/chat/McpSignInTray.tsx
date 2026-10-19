import type {
  CompactMcpStatusActivityPayload,
  OrchestrationThreadActivity,
  ProjectId,
  ProviderKind,
  ThreadId,
} from "@t3tools/contracts";
import { latestMcpStatusActivities } from "@t3tools/shared/orchestrationActivityPayload";
import { ChevronDownIcon, ChevronRightIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import type { ThreadSession } from "../../types";
import { Button } from "../ui/button";
import { McpSignInControls } from "../settings/mcp/McpSignInButton";
import { COMPOSER_TRAY_PANEL_CLASS_NAME } from "./composer/ComposerTray";

type NeedsAuthServer = CompactMcpStatusActivityPayload & { readonly name: string };

/** Servers in the conversation's latest session generation that report needs-auth. */
export function needsAuthMcpServers(
  activities: readonly Pick<OrchestrationThreadActivity, "kind" | "payload">[],
): NeedsAuthServer[] {
  return [...latestMcpStatusActivities(activities).values()].filter(
    (server): server is NeedsAuthServer => server.status === "needs-auth" && !!server.name,
  );
}

/**
 * Codex sign-in is account-scoped. Claude signs in through this conversation's live
 * session, so a stopped session's leftover needs-auth reports offer nothing to click.
 */
export function supportsMcpSignIn(
  provider: ProviderKind | null | undefined,
  sessionStatus: ThreadSession["status"] | null | undefined,
) {
  if (provider === "codex") return true;
  return (
    provider === "claudeAgent" &&
    (sessionStatus === "ready" || sessionStatus === "running" || sessionStatus === "connecting")
  );
}

/** One Sign in control per needs-auth server; Claude routes through this conversation. */
export function McpSignInList(props: {
  readonly servers: readonly NeedsAuthServer[];
  readonly provider: "claudeAgent" | "codex";
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  return (
    <ul className="space-y-2">
      {props.servers.map((server) => (
        <li key={server.name} className="flex flex-wrap items-start gap-x-3 gap-y-1">
          <span className="min-w-24 pt-0.5 font-medium text-foreground">{server.name}</span>
          <McpSignInControls
            provider={props.provider}
            instanceId={server.providerInstanceId}
            projectId={props.projectId}
            serverName={server.name}
            threadId={props.provider === "claudeAgent" ? props.threadId : undefined}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Composer tray row offering sign-in for MCP servers this conversation reports as
 * needs-auth. The browser opens only when a Sign in button is clicked.
 */
export function McpSignInTray(props: {
  readonly provider: ProviderKind | null | undefined;
  readonly sessionStatus: ThreadSession["status"] | null | undefined;
  readonly projectId: ProjectId | undefined;
  readonly threadId: ThreadId;
  readonly activities: readonly OrchestrationThreadActivity[];
}) {
  const [expanded, setExpanded] = useState(false);
  const servers = needsAuthMcpServers(props.activities);
  if (
    !supportsMcpSignIn(props.provider, props.sessionStatus) ||
    !props.projectId ||
    servers.length === 0
  )
    return null;
  const names = servers.map((server) => server.name);
  const summary =
    names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
  return (
    <div
      data-slot="mcp-sign-in-tray"
      className={`${COMPOSER_TRAY_PANEL_CLASS_NAME} space-y-2 text-xs`}
    >
      <div className="flex items-center gap-2">
        <KeyRoundIcon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />
        <span className="min-w-0 flex-1 truncate" title={names.join(", ")}>
          {servers.length === 1
            ? "1 MCP server needs sign-in"
            : `${servers.length} MCP servers need sign-in`}
          <span className="text-muted-foreground"> · {summary}</span>
        </span>
        <Button
          size="xs"
          variant="outline"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          {expanded ? "Hide" : "Sign in…"}
        </Button>
      </div>
      {expanded ? (
        <McpSignInList
          servers={servers}
          provider={props.provider as "claudeAgent" | "codex"}
          projectId={props.projectId}
          threadId={props.threadId}
        />
      ) : null}
    </div>
  );
}
