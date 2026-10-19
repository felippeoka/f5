import { Link } from "@tanstack/react-router";
import { createMcpDiagnosticsSanitizer } from "@t3tools/shared/mcpDiagnostics";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import {
  type ProjectId,
  type CompactMcpStatusActivityPayload,
  type ProviderKind,
} from "@t3tools/contracts";
import { memo } from "react";

interface ProviderRuntimeInfoEntry {
  readonly label: string;
  readonly value: string;
}

export const ProviderRuntimeInfoBanner = memo(function ProviderRuntimeInfoBanner({
  provider,
  entries,
  mcpServers,
  projectId,
}: {
  provider: ProviderKind | null;
  entries: ReadonlyArray<ProviderRuntimeInfoEntry>;
  mcpServers?: ReadonlyArray<CompactMcpStatusActivityPayload> | undefined;
  projectId?: ProjectId | undefined;
}) {
  if (!provider || entries.length === 0) {
    return null;
  }

  const providerLabel =
    provider === "claudeAgent"
      ? "Claude"
      : provider === "codex"
        ? "Codex"
        : provider === "cursor"
          ? "Cursor"
          : provider === "opencode"
            ? "OpenCode"
            : provider;

  return (
    <div
      data-slot="provider-runtime-info"
      className="flex h-7 shrink-0 items-center gap-3 overflow-x-auto px-4 text-2xs text-muted-foreground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <span className="shrink-0 font-medium text-foreground">{providerLabel} runtime</span>
      {entries.map((entry) =>
        entry.label === "MCP" && mcpServers?.length ? (
          <Tooltip key={entry.label}>
            <TooltipTrigger
              className="shrink-0 rounded px-1 text-2xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`MCP: ${entry.value}`}
            >
              MCP <span className="font-mono text-foreground">{entry.value}</span>
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-md">
              <div className="space-y-2 p-1">
                <div className="max-h-72 space-y-2 overflow-y-auto">
                  {mcpServers.map((server, index) => (
                    <div key={server.name ?? index}>
                      <p className="font-medium">
                        {server.name ?? "Unnamed server"} · {server.status}
                      </p>
                      {server.error ? (
                        <p className="whitespace-pre-wrap break-words">
                          {createMcpDiagnosticsSanitizer().text(server.error)}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
                <Link
                  to="/settings"
                  search={
                    projectId
                      ? { category: "project", project: projectId, item: "tools.mcp" }
                      : { category: "tools", item: "tools.mcp" }
                  }
                  className="block underline"
                >
                  Open MCP settings
                </Link>
              </div>
            </TooltipPopup>
          </Tooltip>
        ) : (
          <span key={entry.label} className="flex min-w-0 shrink-0 items-center gap-1">
            <span>{entry.label}</span>
            <span className="max-w-64 truncate font-mono text-foreground" title={entry.value}>
              {entry.value}
            </span>
          </span>
        ),
      )}
    </div>
  );
});
