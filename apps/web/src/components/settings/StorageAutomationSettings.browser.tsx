import "../../index.css";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { StorageAutomationSettings } from "./StorageAutomationSettings";

const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (value: typeof DEFAULT_SERVER_SETTINGS) => unknown) =>
    selector(DEFAULT_SERVER_SETTINGS),
}));
vi.mock("../../nativeApi", () => ({
  ensureNativeApi: () => ({ storage: { automationAudit: mocks.audit } }),
}));
vi.mock("@tanstack/react-router", async () => ({
  ...(await vi.importActual<typeof import("@tanstack/react-router")>("@tanstack/react-router")),
  Link: () => null,
}));
afterEach(() => vi.restoreAllMocks());

it("shows persisted daily backup success and actionable failure status", async () => {
  mocks.audit.mockResolvedValue({
    entries: [],
    scheduledBackupStatus: {
      lastAttemptAt: "2026-10-16T12:00:00.000Z",
      lastSuccessAt: "2026-10-15T12:00:00.000Z",
      lastError: "Owned attachment 'missing' is missing: /storage/missing.txt",
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <StorageAutomationSettings />
    </QueryClientProvider>,
  );
  try {
    await expect.element(page.getByText(/Last successful daily backup:/)).toBeVisible();
    await expect.element(page.getByText(/Last attempt:/)).toBeVisible();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Owned attachment 'missing'");
  } finally {
    await view.unmount();
    client.clear();
  }
});
