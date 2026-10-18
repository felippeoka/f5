import type {
  McpServerStatusesResult,
  ProjectId,
  ProviderInstanceId,
  ProviderKind,
} from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../../ui/button";
import { McpServerInspector } from "./McpServerInspector";

export function McpObservedGroup(props: {
  group: "external" | "built-in";
  observation?: McpServerStatusesResult | undefined;
  projectId: ProjectId | null;
  provider: ProviderKind;
  instanceId: ProviderInstanceId;
}) {
  const [inspected, setInspected] = useState<string | null>(null);
  const entries =
    props.observation?.statuses.filter((server) => server.ownership === props.group) ?? [];
  if (!entries.length) return null;
  return (
    <section className="space-y-2">
      <p className="text-sm font-medium">{props.group === "external" ? "External" : "Built-in"}</p>
      {entries.map((entry, index) => (
        <div
          className="space-y-2 rounded-lg border border-border p-3 text-xs"
          key={`${entry.name}:${index}`}
        >
          <p>
            {entry.name} · {entry.state} ·{" "}
            {entry.origin ??
              (props.group === "built-in" ? "Registered by F5" : "Provider configuration")}
          </p>
          {entry.message ? (
            <p className="whitespace-pre-wrap break-words">{entry.message}</p>
          ) : null}
          {props.projectId ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                setInspected((current) => (current === entry.name ? null : entry.name))
              }
            >
              Inspect {entry.name}
            </Button>
          ) : null}
          {inspected === entry.name && props.projectId ? (
            <McpServerInspector
              provider={props.provider}
              instanceId={props.instanceId}
              projectId={props.projectId}
              serverName={entry.name}
              ownership={props.group}
              observation={props.observation}
            />
          ) : null}
        </div>
      ))}
    </section>
  );
}
