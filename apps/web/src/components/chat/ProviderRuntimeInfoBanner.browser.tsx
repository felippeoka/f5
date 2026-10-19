import "../../index.css";
import { ProjectId, type ProviderKind } from "@t3tools/contracts";
import { latestMcpStatusActivities } from "@t3tools/shared/orchestrationActivityPayload";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  Outlet,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { ProviderRuntimeInfoBanner } from "./ProviderRuntimeInfoBanner";

afterEach(() => {
  document.body.innerHTML = "";
});

it.each(["codex", "claudeAgent"] as ProviderKind[])(
  "shows generation-filtered MCP details and a project settings link for %s",
  async (provider) => {
    const servers = latestMcpStatusActivities([
      { kind: "mcp.status.updated", payload: { name: "legacy", status: "ready" } },
      {
        kind: "mcp.status.updated",
        payload: { name: "old-generation", status: "ready", sessionGeneration: 1 },
      },
      {
        kind: "mcp.status.updated",
        payload: { name: "docs", status: "ready", sessionGeneration: 2 },
      },
      {
        kind: "mcp.status.updated",
        payload: {
          name: "search",
          status: "needs-auth",
          error: "Sign in at https://user:pass@example.test/mcp?token=secret#fragment",
          sessionGeneration: 2,
        },
      },
    ]);
    const root = createRootRoute({ component: () => <Outlet /> });
    const index = createRoute({
      getParentRoute: () => root,
      path: "/",
      component: () => (
        <ProviderRuntimeInfoBanner
          provider={provider}
          projectId={ProjectId.make("project-1")}
          entries={[{ label: "MCP", value: "1/2 connected" }]}
          mcpServers={[...servers.values()]}
        />
      ),
    });
    const router = createRouter({
      routeTree: root.addChildren([index]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();
    const screen = await render(<RouterProvider router={router} />);
    try {
      await page.getByRole("button", { name: "MCP: 1/2 connected" }).hover();
      await expect.element(page.getByText("docs · ready", { exact: true })).toBeVisible();
      await expect.element(page.getByText("search · needs-auth", { exact: true })).toBeVisible();
      expect(document.body.textContent).not.toContain("old-generation");
      expect(document.body.textContent).not.toContain("legacy");
      await expect
        .element(page.getByText("Sign in at https://example.test/mcp", { exact: true }))
        .toBeVisible();
      const link = page.getByRole("link", { name: "Open MCP settings" });
      await expect
        .element(link)
        .toHaveAttribute("href", expect.stringContaining("project=project-1"));
      await expect.element(link).toHaveAttribute("href", expect.stringContaining("item=tools.mcp"));
      await page.screenshot({ fullPage: true });
    } finally {
      await screen.unmount();
    }
  },
);
