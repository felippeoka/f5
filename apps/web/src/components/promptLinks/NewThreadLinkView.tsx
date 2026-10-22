import type { ProjectFindByRepositoryResult, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  parseNewThreadLink,
  promptLinkPullRequestUrl,
  promptLinkRepositoryUrl,
  type NewThreadLink,
  type PromptLinkPullRequest,
} from "@t3tools/shared/promptLinks";
import { formatSourceControlPullRequestKey } from "@t3tools/shared/sourceControl";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { useCreateProjectBackedDraftThread } from "~/hooks/useCreateProjectBackedDraftThread";
import { useStartScratchThread } from "~/hooks/useStartScratchThread";
import { useStartupReady } from "~/lib/startupReady";
import { getMostRecentProject } from "~/lib/threadOrdering";
import { newCommandId, newThreadId } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { useThreadSummaries } from "~/threadSelectors";
import { useServerMutationsAvailable } from "~/wsConnectionState";

import { openProjectCloneDialog } from "../ProjectCloneController";
import { resolvePrF5ModelSelection } from "../prHub/prF5Thread";
import { Button } from "../ui/button";
import { applyLinkedModel, placeLinkedPrompt } from "./linkedPrompt";

type NewLink = Extract<NewThreadLink, { kind: "new" }>;
type PullRequestLink = Extract<NewThreadLink, { kind: "pull-request" }>;
type LinkedProject = ProjectFindByRepositoryResult[number];

type LinkState =
  | { readonly kind: "opening" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "missing-repository"; readonly link: NewThreadLink }
  | {
      readonly kind: "choose-thread";
      readonly link: PullRequestLink;
      readonly threads: ReadonlyArray<{ threadId: ThreadId; title: string }>;
    }
  | {
      readonly kind: "confirm-checkout";
      readonly link: PullRequestLink;
      readonly project: LinkedProject;
    };

const linkRepository = (link: NewThreadLink) =>
  link.kind === "new" ? link.repository : link.pullRequest;

type MostRecentInputs = Parameters<typeof getMostRecentProject>;
interface ActivityInputs {
  readonly threads: MostRecentInputs[1];
  readonly planningWorkflows: MostRecentInputs[2];
  readonly codeReviewWorkflows: MostRecentInputs[3];
  readonly investigationWorkflows: MostRecentInputs[4];
}

/** The matching project the user worked in most recently; the server's order breaks ties. */
function mostRecentlyUsed(
  matches: ProjectFindByRepositoryResult,
  activity: ActivityInputs,
): LinkedProject | undefined {
  const ids = new Set(matches.map((match) => match.projectId));
  const recent = getMostRecentProject(
    useStore.getState().projects.filter((project) => ids.has(project.id)),
    activity.threads,
    activity.planningWorkflows,
    activity.codeReviewWorkflows,
    activity.investigationWorkflows,
  );
  return matches.find((match) => match.projectId === recent?.id) ?? matches[0];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

/** Prepares the pull request in its own worktree and creates a thread there. Nothing is sent. */
async function openPullRequestThread(
  project: LinkedProject,
  pullRequest: PromptLinkPullRequest,
): Promise<ThreadId> {
  const api = ensureNativeApi();
  const url = promptLinkPullRequestUrl(pullRequest);
  const [prepared, peek, config] = await Promise.all([
    api.git.preparePullRequestThread({
      cwd: project.workspaceRoot,
      reference: url,
      mode: "worktree",
    }),
    api.prHub.peek({ url }).catch(() => null),
    api.server.getConfig(),
  ]);
  if (!prepared.worktreePath) {
    throw new Error("F5 did not create an isolated worktree for this pull request.");
  }
  const storeProject = useStore.getState().projects.find((entry) => entry.id === project.projectId);
  const { model, modelSelection } = resolvePrF5ModelSelection(
    config.providers,
    storeProject?.model ?? "",
  );
  const title = peek?.title ?? prepared.pullRequest.title;
  const threadId = newThreadId();
  await api.orchestration.dispatchCommand({
    type: "thread.create",
    commandId: newCommandId(),
    threadId,
    projectId: project.projectId,
    title: `PR #${pullRequest.number}: ${title}`,
    pullRequest: {
      provider: "github",
      host: "github.com",
      repository: `${pullRequest.owner}/${pullRequest.name}`,
      number: pullRequest.number,
      title,
      url,
    },
    model,
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: prepared.branch,
    worktreePath: prepared.worktreePath,
    createdAt: new Date().toISOString(),
  });
  return threadId;
}

/**
 * Opens `f5://new?…` links: finds the project the link names, or offers to clone it, then puts
 * the prompt in a new draft. Pull request links open the pull request's thread, or check it out
 * in a new worktree once the user confirms. A link never sends a message.
 */
export function NewThreadLinkView({ search }: { readonly search: string }) {
  const navigate = useNavigate();
  const createDraftThread = useCreateProjectBackedDraftThread();
  const startScratchThread = useStartScratchThread();
  const [state, setState] = useState<LinkState>({ kind: "opening" });
  const [busy, setBusy] = useState(false);
  const activityInputs: ActivityInputs = {
    threads: useThreadSummaries(),
    planningWorkflows: useStore((store) => store.planningWorkflows),
    codeReviewWorkflows: useStore((store) => store.codeReviewWorkflows),
    investigationWorkflows: useStore((store) => store.investigationWorkflows),
  };
  // Read when the link resolves, so new activity does not reopen the link.
  const activity = useRef(activityInputs);
  useEffect(() => {
    activity.current = activityInputs;
  });

  const openDraft = useCallback(
    async (link: NewLink, projectId: ProjectId | null) => {
      const created =
        projectId === null ? await startScratchThread() : await createDraftThread(projectId);
      if (!created) {
        setState({ kind: "failed", message: "F5 could not create a thread for this prompt." });
        return;
      }
      const note = applyLinkedModel(created.threadId, link);
      placeLinkedPrompt(created.threadId, link.prompt, note ? [note] : []);
    },
    [createDraftThread, startScratchThread],
  );

  const showThread = useCallback(
    async (threadId: ThreadId, link: PullRequestLink) => {
      await navigate({ to: "/$threadId", params: { threadId } });
      if (link.prompt) placeLinkedPrompt(threadId, link.prompt);
    },
    [navigate],
  );

  const openInProject = useCallback(
    async (link: NewThreadLink, project: LinkedProject) => {
      if (link.kind === "new") await openDraft(link, project.projectId);
      else setState({ kind: "confirm-checkout", link, project });
    },
    [openDraft],
  );

  const resolveProject = useCallback(
    async (link: NewThreadLink) => {
      const repository = linkRepository(link);
      if (repository === null) {
        if (link.kind === "new") await openDraft(link, null);
        return;
      }
      const projects = await ensureNativeApi().projects.findByRepository({
        owner: repository.owner,
        name: repository.name,
      });
      const project = mostRecentlyUsed(projects, activity.current);
      if (project) await openInProject(link, project);
      else setState({ kind: "missing-repository", link });
    },
    [openDraft, openInProject],
  );

  // A cold start opened by the link renders this before the server connection has synchronized,
  // and the server refuses changes until then.
  const startupReady = useStartupReady();
  const mutationsAvailable = useServerMutationsAvailable();
  const ready = startupReady && mutationsAvailable;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!ready) return;
    // Refs survive StrictMode's repeated effects, so one link opens one thread.
    if (handled.current === search) return;
    handled.current = search;
    const parsed = parseNewThreadLink(search);
    if (!parsed.ok) {
      setState({ kind: "failed", message: parsed.error });
      return;
    }
    const link = parsed.value;
    setState({ kind: "opening" });
    void (async () => {
      if (link.kind === "pull-request") {
        const key = formatSourceControlPullRequestKey({
          provider: "github",
          host: "github.com",
          repository: `${link.pullRequest.owner}/${link.pullRequest.name}`,
          number: link.pullRequest.number,
        });
        const threads = await ensureNativeApi()
          .prHub.getThreadsForPr({ key })
          .catch(() => []);
        if (threads.length === 1) return showThread(threads[0]!.threadId, link);
        if (threads.length > 1) return setState({ kind: "choose-thread", link, threads });
      }
      await resolveProject(link);
    })().catch((error: unknown) => setState({ kind: "failed", message: errorMessage(error) }));
  }, [ready, resolveProject, search, showThread]);

  const run = (task: () => Promise<unknown>) => {
    setBusy(true);
    void task()
      .catch((error: unknown) => setState({ kind: "failed", message: errorMessage(error) }))
      .finally(() => setBusy(false));
  };

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 p-8 text-sm">
      <LinkStateBody
        state={state}
        busy={busy}
        onThread={(link, threadId) => run(() => showThread(threadId, link))}
        onCheckout={(link, project) =>
          run(async () => showThread(await openPullRequestThread(project, link.pullRequest), link))
        }
        onWithoutProject={(link) => run(() => openDraft(link, null))}
      />
    </div>
  );
}

function LinkStateBody(props: {
  readonly state: LinkState;
  readonly busy: boolean;
  readonly onThread: (link: PullRequestLink, threadId: ThreadId) => void;
  readonly onCheckout: (link: PullRequestLink, project: LinkedProject) => void;
  readonly onWithoutProject: (link: NewLink) => void;
}) {
  const { state, busy } = props;
  switch (state.kind) {
    case "opening":
      return <p className="text-muted-foreground">Opening the link…</p>;
    case "failed":
      return (
        <>
          <h1 className="text-base font-medium">F5 could not open this link</h1>
          <p role="alert" className="text-muted-foreground">
            {state.message}
          </p>
        </>
      );
    case "choose-thread":
      return (
        <>
          <h1 className="text-base font-medium">Choose a thread for this pull request</h1>
          <ul className="flex flex-col gap-2">
            {state.threads.map((thread) => (
              <li key={thread.threadId}>
                <Button
                  variant="outline"
                  className="w-full justify-start"
                  disabled={busy}
                  onClick={() => props.onThread(state.link, thread.threadId)}
                >
                  {thread.title}
                </Button>
              </li>
            ))}
          </ul>
        </>
      );
    case "missing-repository": {
      const repository = linkRepository(state.link)!;
      const url = promptLinkRepositoryUrl(repository);
      const link = state.link;
      return (
        <>
          <h1 className="text-base font-medium">
            No project here uses {repository.owner}/{repository.name}
          </h1>
          <p className="text-muted-foreground">
            Clone it, then open this link again when the clone finishes.
          </p>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => openProjectCloneDialog("", url)}>
              Clone {url}
            </Button>
            {link.kind === "new" && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => props.onWithoutProject(link)}
              >
                Use without a project
              </Button>
            )}
          </div>
        </>
      );
    }
    case "confirm-checkout": {
      const { link, project } = state;
      return (
        <>
          <h1 className="text-base font-medium">
            Check out pull request #{link.pullRequest.number}?
          </h1>
          <p className="text-muted-foreground">
            F5 creates a new worktree of {project.title} for{" "}
            {promptLinkPullRequestUrl(link.pullRequest)} and opens a thread there.
          </p>
          <div>
            <Button disabled={busy} onClick={() => props.onCheckout(link, project)}>
              {busy ? "Checking out…" : "Check out in a new worktree"}
            </Button>
          </div>
        </>
      );
    }
  }
}
