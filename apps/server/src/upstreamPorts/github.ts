/**
 * The GitHub operations upstream ports need: the rolling ledger PR and
 * upstream PR bodies for triage digests.
 *
 * @module upstreamPorts/github
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import type { GitHubCliShape } from "../git/Services/GitHubCli.ts";

export interface LedgerPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
}

export interface GitHubRepoRef {
  readonly owner: string;
  readonly name: string;
}

export interface UpstreamGitHub {
  readonly available: (cwd: string) => Effect.Effect<boolean>;
  /** The PR whose head is `branch`, or null when none exists. */
  readonly findPullRequest: (
    cwd: string,
    reference: string,
  ) => Effect.Effect<LedgerPullRequest | null, Error>;
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly base: string;
    readonly head: string;
    readonly title: string;
    readonly body: string;
  }) => Effect.Effect<LedgerPullRequest, Error>;
  readonly updatePullRequestBody: (input: {
    readonly cwd: string;
    readonly repo: GitHubRepoRef;
    readonly number: number;
    readonly body: string;
  }) => Effect.Effect<void, Error>;
  /** PR bodies keyed by number; numbers that cannot be read are omitted. */
  readonly fetchPullRequestBodies: (input: {
    readonly cwd: string;
    readonly repo: GitHubRepoRef;
    readonly numbers: ReadonlyArray<number>;
  }) => Effect.Effect<Map<number, string>, Error>;
}

export function parseGitHubRepo(url: string): GitHubRepoRef | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(
      url.trim(),
    );
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

export const PR_BODY_BATCH = 50;

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

export function makeUpstreamGitHub(cli: GitHubCliShape): UpstreamGitHub {
  const available: UpstreamGitHub["available"] = (cwd) =>
    cli
      .execute({
        cwd,
        args: ["auth", "status", "--hostname", "github.com"],
        timeoutMs: 15_000,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.code === 0),
        Effect.orElseSucceed(() => false),
      );

  const findPullRequest: UpstreamGitHub["findPullRequest"] = (cwd, reference) =>
    cli.getPullRequest({ cwd, reference }).pipe(
      Effect.map(
        (pr) =>
          ({ number: pr.number, url: pr.url, state: pr.state ?? "open" }) as LedgerPullRequest,
      ),
      Effect.catch((error) =>
        /no pull requests? found|could not resolve/iu.test(error.message)
          ? Effect.succeed(null)
          : Effect.fail(asError(error)),
      ),
    );

  const createPullRequest: UpstreamGitHub["createPullRequest"] = (input) =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "f5-upstream-pr-"))),
      (directory) =>
        Effect.gen(function* () {
          const bodyFile = path.join(directory, "body.md");
          yield* Effect.promise(() => writeFile(bodyFile, input.body));
          yield* cli.createPullRequest({
            cwd: input.cwd,
            baseBranch: input.base,
            headSelector: input.head,
            title: input.title,
            bodyFile,
          });
          const created = yield* findPullRequest(input.cwd, input.head);
          if (!created)
            return yield* Effect.fail(
              new Error("The ledger pull request was not found after creation."),
            );
          return created;
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    ).pipe(Effect.mapError(asError));

  const updatePullRequestBody: UpstreamGitHub["updatePullRequestBody"] = (input) =>
    cli
      .execute({
        cwd: input.cwd,
        args: [
          "api",
          "-X",
          "PATCH",
          `repos/${input.repo.owner}/${input.repo.name}/pulls/${input.number}`,
          "--input",
          "-",
        ],
        stdin: JSON.stringify({ body: input.body }),
        timeoutMs: 30_000,
      })
      .pipe(Effect.asVoid, Effect.mapError(asError));

  const fetchPullRequestBodies: UpstreamGitHub["fetchPullRequestBodies"] = (input) =>
    Effect.gen(function* () {
      const out = new Map<number, string>();
      const unique = [...new Set(input.numbers)];
      for (let start = 0; start < unique.length; start += PR_BODY_BATCH) {
        const batch = unique.slice(start, start + PR_BODY_BATCH);
        const fields = batch
          .map((number) => `p${number}: pullRequest(number: ${number}) { body }`)
          .join("\n");
        const response = yield* cli.runGraphql({
          cwd: input.cwd,
          query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
          variables: { owner: input.repo.owner, name: input.repo.name },
        });
        const repository = (
          response as { data?: { repository?: Record<string, { body?: unknown } | null> } }
        )?.data?.repository;
        for (const number of batch) {
          const body = repository?.[`p${number}`]?.body;
          if (typeof body === "string") out.set(number, body);
        }
      }
      return out;
    }).pipe(Effect.mapError(asError));

  return {
    available,
    findPullRequest,
    createPullRequest,
    updatePullRequestBody,
    fetchPullRequestBodies,
  };
}
