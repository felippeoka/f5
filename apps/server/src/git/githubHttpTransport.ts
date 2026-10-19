import { Effect } from "effect";
import { GitHubCliError } from "./Errors.ts";
import type { GitHubCliShape } from "./Services/GitHubCli.ts";

/** Keep the existing captured-request boundary; its scheduler and cache remain authoritative. */
export function makeGitHubHttpTransport(
  fetcher: (...args: Parameters<typeof fetch>) => Promise<Response> = globalThis.fetch,
): GitHubCliShape["execute"] {
  return (input) =>
    Effect.suspend(() => {
      const timeout = AbortSignal.timeout(input.timeoutMs ?? 45_000);
      return Effect.tryPromise({
        try: async (interrupted) => {
          const option = (name: string) => {
            const index = input.args.indexOf(name);
            return index < 0 ? undefined : input.args[index + 1];
          };
          const host = option("--hostname");
          const endpoint = input.args[1];
          if (
            input.args[0] !== "api" ||
            !host ||
            !endpoint ||
            !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) ||
            host.includes("..") ||
            endpoint.startsWith("/") ||
            endpoint.includes("\\") ||
            /[\r\n]/.test(endpoint)
          )
            throw new Error("Invalid captured GitHub HTTP request");
          const cloud = host === "github.com" || host.endsWith(".ghe.com");
          const base = cloud ? `https://api.${host}/` : `https://${host}/api/v3/`;
          const url =
            endpoint === "graphql" && !cloud
              ? new URL(`https://${host}/api/graphql`)
              : new URL(endpoint, base);
          if (url.origin !== new URL(base).origin) throw new Error("Invalid GitHub API origin");
          const token = input.env?.[cloud ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"];
          const headers = new Headers({
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "f5-server",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(input.stdin === undefined ? {} : { "Content-Type": "application/json" }),
          });
          for (let index = 2; index < input.args.length; index++) {
            if (input.args[index] !== "--header") continue;
            const value = input.args[++index] ?? "";
            const colon = value.indexOf(":");
            const name = value.slice(0, colon).toLowerCase();
            if (colon < 1 || !["if-none-match", "if-modified-since", "accept"].includes(name))
              throw new Error("Invalid GitHub conditional header");
            const headerValue = value.slice(colon + 1).trim();
            if (name === "accept" && headerValue !== "application/vnd.github.diff")
              throw new Error("Invalid GitHub response format");
            headers.set(name, headerValue);
          }
          const signal = AbortSignal.any([
            interrupted,
            timeout,
            ...(input.signal ? [input.signal] : []),
          ]);
          const response = await fetcher(url, {
            method: option("--method") ?? "GET",
            headers,
            ...(input.stdin === undefined ? {} : { body: input.stdin }),
            signal,
            redirect: "error",
          });
          const limit = input.maxStdoutBytes ?? 8 * 1024 * 1024;
          const headerText = `HTTP/1.1 ${response.status} Response\r\n${[...response.headers].map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n`;
          let bytes = Buffer.byteLength(headerText);
          if (bytes > limit) {
            await response.body?.cancel();
            throw new Error("GitHub response exceeds limit");
          }
          const chunks: Uint8Array[] = [];
          const reader = response.body?.getReader();
          try {
            while (reader) {
              const chunk = await reader.read();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > limit) throw new Error("GitHub response exceeds limit");
              chunks.push(chunk.value);
            }
          } finally {
            if (reader) {
              await reader.cancel().catch(() => undefined);
              reader.releaseLock();
            }
          }
          return {
            stdout: headerText + Buffer.concat(chunks).toString("utf8"),
            stderr: "",
            code: response.ok || response.status === 304 ? 0 : 1,
            signal: null,
            timedOut: false,
          };
        },
        catch: () =>
          new GitHubCliError({
            operation: "request",
            kind: timeout.aborted ? "timeout" : input.signal?.aborted ? "generic" : "network",
            detail: "GitHub HTTP request failed, was interrupted, or exceeded its response limit.",
          }),
      });
    });
}
