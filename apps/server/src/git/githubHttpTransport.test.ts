import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeGitHubHttpTransport } from "./githubHttpTransport.ts";
import { parseGitHubApiResponse } from "./githubApi.ts";

describe("GitHub HTTP transport", () => {
  it.each([
    ["github.com", "repos/o/r", "https://api.github.com/repos/o/r"],
    ["example.ghe.com", "graphql", "https://api.example.ghe.com/graphql"],
    ["git.example.test", "graphql", "https://git.example.test/api/graphql"],
    [
      "git.example.test",
      "repos/o/r?per_page=100",
      "https://git.example.test/api/v3/repos/o/r?per_page=100",
    ],
  ])("routes %s/%s with private credentials", async (host, endpoint, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ id: 1 }), {
        headers: { ETag: '"version"', "x-ratelimit-remaining": "15" },
      }),
    );
    const result = await Effect.runPromise(
      makeGitHubHttpTransport(fetcher)({
        cwd: ".",
        args: [
          "api",
          endpoint!,
          "--hostname",
          host!,
          "--method",
          "POST",
          "--include",
          "--header",
          'If-None-Match: "version"',
        ],
        env: { GH_TOKEN: "cloud-secret", GH_ENTERPRISE_TOKEN: "enterprise-secret" },
        stdin: '{"query":"test"}',
      }),
    );
    const [url, options] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(expected);
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("authorization")).toBe(
      `Bearer ${host!.endsWith(".test") ? "enterprise-secret" : "cloud-secret"}`,
    );
    expect(options?.body).toBe('{"query":"test"}');
    expect(parseGitHubApiResponse(result.stdout)).toMatchObject({
      status: 200,
      body: { id: 1 },
      etag: '"version"',
      rateLimit: { remaining: 15 },
    });
  });
  it("cancels oversized response streams without exposing their content", async () => {
    const canceled = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("private".repeat(2000)));
          },
          cancel: canceled,
        }),
      ),
    );
    const result = await Effect.runPromise(
      makeGitHubHttpTransport(fetcher)({
        cwd: ".",
        args: ["api", "user", "--hostname", "github.com"],
        maxStdoutBytes: 1024,
      }).pipe(Effect.flip),
    );
    expect(result.detail).not.toContain("private");
    expect(canceled).toHaveBeenCalledOnce();
  });
  it("classifies a stalled request deadline without exposing fetch errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("private fetch payload")),
            { once: true },
          );
        }),
    );
    const result = await Effect.runPromise(
      makeGitHubHttpTransport(fetcher)({
        cwd: ".",
        args: ["api", "user", "--hostname", "github.com"],
        timeoutMs: 5,
      }).pipe(Effect.flip),
    );
    expect(result.kind).toBe("timeout");
    expect(result.detail).not.toContain("private fetch payload");
  });
  it("does not follow redirects or send arbitrary headers", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await Effect.runPromise(
      makeGitHubHttpTransport(fetcher)({
        cwd: ".",
        args: ["api", "user", "--hostname", "github.com", "--header", "Authorization: stolen"],
      }).pipe(Effect.flip),
    );
    expect(result.kind).toBe("network");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

it("preserves diff text and sends only the fixed diff media type", async () => {
  const fetcher = vi.fn<(...args: Parameters<typeof fetch>) => Promise<Response>>(
    async () => new Response("diff --git a/a b/a\n+hello\n"),
  );
  const result = await Effect.runPromise(
    makeGitHubHttpTransport(fetcher)({
      cwd: "/repo",
      args: [
        "api",
        "repos/octo/repo/pulls/7",
        "--hostname",
        "github.com",
        "--method",
        "GET",
        "--header",
        "Accept: application/vnd.github.diff",
      ],
      env: { GH_TOKEN: "token" },
    }),
  );
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("accept")).toBe(
    "application/vnd.github.diff",
  );
  expect(result.stdout).toContain("diff --git a/a b/a\n+hello\n");
});
