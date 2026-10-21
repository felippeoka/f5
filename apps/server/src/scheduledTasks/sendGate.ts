import type { ServerSettings } from "@t3tools/contracts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
export const scheduledSendGate = (
  sql: SqlClient.SqlClient,
  settings: ServerSettings,
  commandId: string,
) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      owner: number;
      capacity: number;
      canceled: number;
      epoch: number;
      enabled: number;
      ready: number;
      snapshot: string;
    }>`SELECT r.owns_execution AS owner,r.capacity,r.canceled,c.epoch,c.enabled,c.ready,r.snapshot_json AS snapshot FROM scheduled_run_submissions s JOIN scheduled_task_runs r ON r.id=s.run_id JOIN scheduled_control c ON c.id=1 WHERE s.submission_id=${commandId}`;
    const row = rows[0];
    if (!row) return "ready" as const;
    if (!row.owner || row.canceled) return "cancel" as const;
    const snapshot = JSON.parse(row.snapshot) as {
      authority: { kind: string; clientId?: string; grantGeneration?: number };
      projectId: string;
    };
    if (snapshot.authority.kind === "agent") {
      const clients = yield* sql<{
        scopes: string;
        generation: number;
        revoked: string | null;
        projects: string;
      }>`SELECT scopes_json AS scopes,grant_generation AS generation,revoked_at AS revoked,project_ids_json AS projects FROM agent_bridge_clients WHERE id=${snapshot.authority.clientId!}`;
      const client = clients[0];
      if (
        !settings.agentBridge.enabled ||
        !client ||
        client.revoked ||
        client.generation !== snapshot.authority.grantGeneration ||
        !(JSON.parse(client.scopes) as string[]).includes("f5.schedules") ||
        !settings.agentBridge.exposedProjectIds.some((id) => id === snapshot.projectId) ||
        (snapshot.authority.clientId !== "local" &&
          !(JSON.parse(client.projects) as string[]).includes(snapshot.projectId))
      )
        return "cancel" as const;
    }
    return row.ready === 1 &&
      settings.scheduledTasks.enabled &&
      row.enabled === 1 &&
      row.epoch === settings.scheduledTasks.epoch &&
      row.capacity === 1
      ? ("ready" as const)
      : ("wait" as const);
  });
