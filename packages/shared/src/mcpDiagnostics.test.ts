import { describe, expect, it } from "vitest";
import { createMcpDiagnosticsSanitizer } from "./mcpDiagnostics";

describe("MCP diagnostics redaction", () => {
  const safe = createMcpDiagnosticsSanitizer({
    docs: {
      type: "http",
      url: "https://example.test",
      headers: { Authorization: "header-value-secret" },
    },
    local: { type: "stdio", command: "node", env: { LONG: "env-value-secret", SHORT: "abc" } },
  });
  it("scrubs configured values without corrupting text with short values", () => {
    expect(safe.text("abc env-value-secret header-value-secret")).toBe("abc [redacted] [redacted]");
  });
  it("strips URL credentials, query strings, and fragments", () => {
    expect(safe.text("Error at https://user:password@example.test/path?token=bad#frag")).toBe(
      "Error at https://example.test/path",
    );
  });
  it("strips credentials and query strings from non-HTTP endpoint URLs", () => {
    expect(safe.text("postgres://user:password@database.test/db?key=secret#fragment")).toBe(
      "postgres://database.test/db",
    );
  });
  it("redacts credential fields and header names", () => {
    expect(
      safe.json({
        Authorization: "Bearer abc",
        "x-api-key": "key",
        "x-access-token": "token",
        clientSecret: "secret",
        authorizationUrl: "https://auth.test/callback",
      }),
    ).toEqual({
      Authorization: "[redacted]",
      "x-api-key": "[redacted]",
      "x-access-token": "[redacted]",
      clientSecret: "[redacted]",
      authorizationUrl: "[redacted]",
    });
    expect(safe.text("Authorization: Bearer abcdefgh")).toBe("Authorization: [redacted]");
  });
});
