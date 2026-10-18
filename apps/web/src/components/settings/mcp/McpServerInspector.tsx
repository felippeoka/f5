import type {
  McpServerStatusesResult,
  McpSessionReloadOutcome,
  ProjectId,
  ProviderInstanceId,
  ProviderKind,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { mcpInspectServerQueryOptions, mcpQueryKeys } from "../../../lib/mcpReactQuery";
import { ensureNativeApi } from "../../../nativeApi";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { Button } from "../../ui/button";
import { readErrorMessage } from "./mcpSettingsHelpers";

type InspectorTab = "Overview" | "Tools" | "Resources" | "Diagnostics";

export function McpServerInspector(props: {
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
  projectId: ProjectId;
  serverName: string;
  ownership?: "managed" | "external" | "built-in";
  observation?: McpServerStatusesResult | undefined;
  outcomes?: ReadonlyArray<McpSessionReloadOutcome> | undefined;
}) {
  const [tab, setTab] = useState<InspectorTab>("Overview");
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryOutcomes, setRetryOutcomes] = useState<ReadonlyArray<McpSessionReloadOutcome>>();
  const queryClient = useQueryClient();
  const query = useQuery(mcpInspectServerQueryOptions({ ...props, serverName: props.serverName }));
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const data = query.data;
  const status = data?.statuses.find(
    (entry) =>
      entry.name === props.serverName &&
      (entry.ownership ?? "managed") === (props.ownership ?? "managed"),
  );
  return (
    <section
      className="space-y-3 rounded-md border border-border p-3"
      aria-label={`Inspect ${props.serverName}`}
    >
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Server inspector">
        {(["Overview", "Tools", "Resources", "Diagnostics"] as const).map((value) => (
          <Button
            key={value}
            size="xs"
            variant={tab === value ? "secondary" : "outline"}
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
          >
            {value}
          </Button>
        ))}
        <Button
          size="xs"
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh inspector
        </Button>
      </div>
      {query.isPending ? <p className="text-xs text-muted-foreground">Loading inspector…</p> : null}
      {query.error ? (
        <p className="text-xs text-destructive">
          {readErrorMessage(query.error, "Could not inspect this server.")}
        </p>
      ) : null}
      {data ? (
        <div role="tabpanel" className="space-y-2 text-xs">
          {tab === "Overview" ? (
            <>
              <p>
                Saved:{" "}
                {status?.desiredEnabled === undefined
                  ? "External configuration"
                  : status.desiredEnabled
                    ? "Enabled"
                    : "Disabled"}{" "}
                · Observed: {status?.state ?? "Unknown"}
              </p>
              <p>
                {data.source === "conversation"
                  ? `Observed in ${data.threadId}`
                  : "Configuration check"}{" "}
                at{" "}
                {data.observedAt ? new Date(data.observedAt).toLocaleTimeString() : "unknown time"}
              </p>
              <p>
                Saved version: {data.desiredVersion ?? "unknown"} · Applied version:{" "}
                {data.appliedVersion ?? "not a conversation"}
              </p>
              {status?.message ? (
                <p className="whitespace-pre-wrap break-words">{status.message}</p>
              ) : null}
            </>
          ) : null}
          {tab === "Tools" ? (
            <>
              {!data.capabilities.tools ? (
                <p>Tools are not available from this provider runtime.</p>
              ) : data.tools.length === 0 ? (
                <p>No tools were reported in this observation.</p>
              ) : (
                data.tools.map((tool, index) => (
                  <details
                    key={`${tool.name}:${index}`}
                    className="rounded border border-border p-2"
                  >
                    <summary>{tool.name}</summary>
                    {tool.description ? (
                      <p className="whitespace-pre-wrap break-words">{tool.description}</p>
                    ) : null}
                    {tool.annotations !== undefined ? (
                      <pre className="overflow-auto whitespace-pre-wrap break-all">
                        {JSON.stringify(tool.annotations, null, 2)}
                      </pre>
                    ) : null}
                    {data.capabilities.inputSchemas ? (
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                        {JSON.stringify(tool.inputSchema ?? {}, null, 2)}
                      </pre>
                    ) : (
                      <p>
                        {props.provider === "claudeAgent"
                          ? "Input schemas are not available from Claude."
                          : "Input schemas are not available from this runtime."}
                      </p>
                    )}
                  </details>
                ))
              )}
              {!data.capabilities.inputSchemas ? (
                <p>
                  {props.provider === "claudeAgent"
                    ? "Input schemas are not available from Claude."
                    : "Input schemas are not available from this runtime."}
                </p>
              ) : null}
            </>
          ) : null}
          {tab === "Resources" ? (
            !data.capabilities.resources ? (
              <p>
                {props.provider === "claudeAgent"
                  ? "Resources are not available from Claude."
                  : "Resources are not available from this runtime."}
              </p>
            ) : (
              <>
                <p>
                  {data.resources.length} resources · {data.resourceTemplates.length} templates.
                  Metadata only.
                </p>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(
                    { resources: data.resources, templates: data.resourceTemplates },
                    null,
                    2,
                  )}
                </pre>
              </>
            )
          ) : null}
          {tab === "Diagnostics" ? (
            <>
              <p>{data.complete ? "Complete observation" : "Partial observation"}</p>
              <p>Historical activity for this conversation, account, and generation:</p>
              {data.diagnostics.length ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
                  {JSON.stringify(data.diagnostics, null, 2)}
                </pre>
              ) : (
                <p>No stamped historical diagnostics.</p>
              )}
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void copyToClipboard(
                    JSON.stringify(
                      {
                        source: data.source,
                        observedAt: data.observedAt,
                        instanceId: data.instanceId,
                        threadId: data.threadId,
                        generation: data.generation,
                        desiredVersion: data.desiredVersion,
                        appliedVersion: data.appliedVersion,
                        complete: data.complete,
                        states: data.statuses.map(({ name, state, message, desiredEnabled }) => ({
                          name,
                          state,
                          message,
                          desiredEnabled,
                        })),
                        omissions: data.omissions,
                        diagnostics: data.diagnostics,
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                {isCopied ? "Copied" : "Copy diagnostics"}
              </Button>
            </>
          ) : null}
          {data.omissions?.map((omission) => (
            <p key={omission} className="text-warning">
              {omission}
            </p>
          ))}
        </div>
      ) : null}
      {(retryOutcomes ?? props.outcomes ?? data?.outcomes)?.map((outcome) => (
        <div key={`${outcome.threadId}:${outcome.generation}`} className="space-y-1 text-xs">
          <p>
            {outcome.threadId} · generation {outcome.generation}: {outcome.disposition}
          </p>
          {outcome.result.errors.map((error, index) => (
            <p key={index} className="whitespace-pre-wrap break-words">
              {error.message}
            </p>
          ))}
          {outcome.disposition !== "applied" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                setRetryError(null);
                void ensureNativeApi()
                  .mcp.applyToLiveSessions({
                    scope: "project",
                    projectId: props.projectId,
                    instanceId: props.instanceId,
                    threadIds: [outcome.threadId],
                    retryUnchanged: true,
                  })
                  .then((result) => {
                    setRetryOutcomes(result.sessions);
                    return queryClient.invalidateQueries({ queryKey: mcpQueryKeys.all });
                  })
                  .catch((error) => setRetryError(readErrorMessage(error, "Retry failed.")))
                  .finally(() => setRetrying(false));
              }}
            >
              Retry in this conversation
            </Button>
          ) : null}
        </div>
      ))}
      {retryError ? <p className="text-xs text-destructive">{retryError}</p> : null}
    </section>
  );
}
