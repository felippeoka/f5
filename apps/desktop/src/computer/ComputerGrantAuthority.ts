import { randomUUID } from "node:crypto";
import type {
  ComputerAccessAnswer,
  ComputerAccessRequested,
  ComputerAuthorization,
  ComputerGrant,
} from "@t3tools/contracts";
import { appTier, restrictComputerTier, type ComputerPlatform } from "@t3tools/shared/computerApps";

interface Approval {
  profileId: string;
  projectId: string;
  threadId: string;
  generation: string;
  remembered: boolean;
  grant: ComputerGrant;
  sessions: Set<string>;
}

/** Only native consent can mint receipts. No backend or filesystem content is authority.
 * Preview receipts intentionally expire when desktop main exits; there is no disk secret.
 */
export class ComputerGrantAuthority {
  private readonly approvals = new Map<string, Approval>();
  private readonly active = new Map<string, ReadonlyArray<ComputerGrant>>();
  private readonly revoked = new Map<string, Set<string>>();
  constructor(private readonly platform: ComputerPlatform) {}

  issue(
    profileId: string,
    request: ComputerAccessRequested,
    answer: ComputerAccessAnswer,
  ): ComputerAccessAnswer {
    const decisions = answer.decisions.map((decision) => {
      const app = request.apps.find((entry) => entry.appId === decision.appId);
      if (!decision.allow || !app || !request.projectId || !request.sessionGeneration)
        return { ...decision, allow: false };
      const tier = restrictComputerTier(app.tier, appTier(app.appId, this.platform));
      if (tier === "blocked" || this.approvals.size >= 10_000) return { ...decision, allow: false };
      const receipt = randomUUID();
      const grant = {
        appId: app.appId,
        tier,
        allowTyping: tier === "click" && decision.allowTyping,
        receipt,
      };
      this.approvals.set(receipt, {
        profileId,
        projectId: request.projectId,
        threadId: request.threadId,
        generation: request.sessionGeneration,
        remembered: decision.remember,
        grant,
        sessions: new Set(),
      });
      return { ...decision, allowTyping: grant.allowTyping, receipt };
    });
    return { ...answer, decisions };
  }

  remembered(
    profileId: string,
    projectId: string,
    grants: ReadonlyArray<ComputerGrant>,
  ): ReadonlyArray<ComputerGrant> {
    return grants.filter((grant) => {
      const approval = grant.receipt ? this.approvals.get(grant.receipt) : undefined;
      return (
        approval?.remembered &&
        approval.profileId === profileId &&
        approval.projectId === projectId &&
        this.matches(approval, grant)
      );
    });
  }

  forget(profileId: string, projectId: string, appId: string): void {
    for (const approval of this.approvals.values())
      if (
        approval.profileId === profileId &&
        approval.projectId === projectId &&
        approval.grant.appId === appId
      )
        approval.remembered = false;
  }

  validate(authorization: ComputerAuthorization): ComputerAuthorization {
    const key = `${authorization.profileId}\0${authorization.threadId}\0${authorization.sessionGeneration}`;
    const revoked = this.revoked.get(key) ?? new Set<string>();
    for (const previous of this.active.get(key) ?? [])
      if (
        previous.receipt &&
        !authorization.grants.some((grant) => grant.receipt === previous.receipt)
      )
        revoked.add(previous.receipt);
    this.revoked.set(key, revoked);
    const grants = authorization.grants.filter((grant) => {
      const approval = grant.receipt ? this.approvals.get(grant.receipt) : undefined;
      const allowed = Boolean(
        approval &&
        !revoked.has(grant.receipt!) &&
        approval.profileId === authorization.profileId &&
        approval.projectId === authorization.projectId &&
        this.matches(approval, grant) &&
        (approval.remembered ||
          approval.sessions.has(key) ||
          (approval.threadId === authorization.threadId &&
            approval.generation === authorization.sessionGeneration)),
      );
      if (allowed) approval!.sessions.add(key);
      return allowed;
    });
    this.active.set(key, grants);
    return { ...authorization, grants };
  }

  disconnect(profileId: string): void {
    for (const [id, approval] of this.approvals)
      if (approval.profileId === profileId && !approval.remembered) this.approvals.delete(id);
    for (const map of [this.active, this.revoked])
      for (const key of map.keys()) if (key.startsWith(`${profileId}\0`)) map.delete(key);
  }
  private matches(approval: Approval, grant: ComputerGrant): boolean {
    return (
      approval.grant.appId === grant.appId &&
      approval.grant.tier === grant.tier &&
      approval.grant.allowTyping === grant.allowTyping
    );
  }
}
