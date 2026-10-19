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
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { vi } from "vitest";
import { ProviderRuntimeInfoBanner } from "./ProviderRuntimeInfoBanner";

const { getEffectiveConfig } = vi.hoisted(() => ({ getEffectiveConfig: vi.fn() }));
vi.mock("../../nativeApi", () => ({ ensureNativeApi: () => ({ mcp: { getEffectiveConfig } }) }));

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
          error:
            "configured-secret-value Sign in at https://user:pass@example.test/mcp?token=secret#fragment",
          sessionGeneration: 2,
        },
      },
    ]);
    getEffectiveConfig.mockResolvedValue({
      projectId: "project-1",
      effectiveVersion: "v1",
      servers: {
        docs: {
          type: "http",
          url: "https://example.test",
          headers: { "X-Key": "configured-secret-value" },
        },
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    try {
      const trigger = page.getByRole("button", { name: "MCP: 1/2 connected" });
      trigger.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByText("docs · ready", { exact: true })).toBeVisible();
      await expect.element(page.getByText("search · needs-auth", { exact: true })).toBeVisible();
      expect(document.body.textContent).not.toContain("old-generation");
      expect(document.body.textContent).not.toContain("legacy");
      await expect
        .element(page.getByText("[redacted] Sign in at https://example.test/mcp", { exact: true }))
        .toBeVisible();
      const link = page.getByRole("link", { name: "Open MCP settings" });
      await expect
        .element(link)
        .toHaveAttribute("href", expect.stringContaining("project=project-1"));
      await expect.element(link).toHaveAttribute("href", expect.stringContaining("item=tools.mcp"));
      await expect.element(link).toHaveFocus();
      await expect.element(link).toHaveAttribute("href", expect.stringContaining("category=tools"));
      await page.screenshot({ fullPage: true });
      await userEvent.keyboard("{Escape}");
      await expect.element(trigger).toHaveFocus();
      queryClient.removeQueries({ queryKey: ["mcp", "effectiveConfig"] });
      getEffectiveConfig.mockRejectedValueOnce(new Error("Configuration unavailable"));
      await trigger.click();
      await expect
        .element(
          page.getByText(
            "Error details unavailable until configuration loads. Open MCP settings for details.",
            { exact: true },
          ),
        )
        .toBeVisible();
      expect(document.body.textContent).not.toContain("configured-secret-value");
    } finally {
      queryClient.clear();
      await screen.unmount();
    }
  },
);
