import type { McpProjectServersConfig } from "@t3tools/contracts";

const credentialKey =
  /(?:authorization|(?:^|[-_])(?:token|key)$|secret$|authorizationUrl|bearer_token)/i;

/** Supplemental value scrubbing; transformed credentials cannot be guaranteed to match. */
export function createMcpDiagnosticsSanitizer(
  servers: McpProjectServersConfig = {},
  additionalValues: ReadonlyArray<string> = [],
) {
  const values = [
    ...new Set(
      [
        ...Object.values(servers).flatMap((server) => [
          ...Object.values(server.env ?? {}),
          ...Object.values(server.headers ?? {}),
        ]),
        ...additionalValues,
      ].filter((value) => value.length >= 8),
    ),
  ].sort((a, b) => b.length - a.length);
  const text = (value: string): string => {
    let result = value;
    for (const secret of values) result = result.split(secret).join("[redacted]");
    result = result.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        if (!url.hostname) return "[redacted URL]";
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[redacted URL]";
      }
    });
    return result
      .replace(
        /\b(authorization|[\w-]+(?:-token|-key|secret))\s*[:=]\s*[^\r\n,;}]+/gi,
        "$1: [redacted]",
      )
      .slice(0, 8192);
  };
  const json = (value: unknown, depth = 0): unknown => {
    if (depth > 32) return "[omitted: nesting depth]";
    if (typeof value === "string") return text(value);
    if (value === null || typeof value === "boolean" || typeof value === "number") return value;
    if (Array.isArray(value)) return value.slice(0, 1000).map((entry) => json(entry, depth + 1));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 1000)
          .map(([key, child]) => [
            key,
            credentialKey.test(key) ? "[redacted]" : json(child, depth + 1),
          ]),
      );
    return null;
  };
  return { text, json };
}

export function sanitizeMcpReconnectResult(
  result: import("@t3tools/contracts").McpReconnectServerResult,
  servers: McpProjectServersConfig,
) {
  const sanitizer = createMcpDiagnosticsSanitizer(servers);
  return {
    ...result,
    failures: result.failures
      .slice(0, 1000)
      .map((failure) => ({ ...failure, message: sanitizer.text(failure.message).slice(0, 2000) })),
    ...(result.sessions
      ? {
          sessions: result.sessions.slice(0, 1000).map((session) => ({
            ...session,
            result: {
              ...session.result,
              errors: session.result.errors.slice(0, 1000).map((error) => ({
                ...error,
                message: sanitizer.text(error.message).slice(0, 2000),
              })),
            },
          })),
        }
      : {}),
  };
}
