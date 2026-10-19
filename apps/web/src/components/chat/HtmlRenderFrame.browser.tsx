import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { TooltipProvider } from "../ui/tooltip";
import { HtmlRenderFrame } from "./HtmlRenderFrame";

const api = vi.hoisted(() => ({
  bindings: [] as import("@t3tools/contracts").ResolvedKeybindingsConfig,
  openExternal: vi.fn(async () => undefined),
}));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({
    shell: api,
    server: { getConfig: async () => ({ keybindings: api.bindings }) },
  }),
  ensureNativeApi: () => ({
    shell: api,
    server: { getConfig: async () => ({ keybindings: api.bindings }) },
  }),
}));
const reference = { attachmentId: "html-page", title: "HTML widget", height: 120 };
const originalFetch = globalThis.fetch;
let source = "";
let active: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  source = "<p>Hello</p>";
  api.bindings = [];
  api.openExternal.mockClear();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input).includes("/attachments/html-page")
      ? Promise.resolve(new Response(source, { headers: { "content-type": "text/html" } }))
      : originalFetch(input, init),
  );
});
afterEach(async () => {
  await active?.unmount();
  active = undefined;
  vi.restoreAllMocks();
});
async function mount(onImageExpand = vi.fn()) {
  active = await render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>
        <HtmlRenderFrame reference={reference} onImageExpand={onImageExpand} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  await expect
    .poll(() => document.querySelector<HTMLIFrameElement>('iframe[title="HTML widget"]')?.srcdoc)
    .toContain("Hello");
}
it("runs JavaScript in an opaque sandbox that cannot access the parent or Node", async () => {
  const reports: unknown[] = [];
  const receive = (event: MessageEvent) => {
    if (event.data?.probe) reports.push(event.data);
  };
  window.addEventListener("message", receive);
  source =
    '<p>Hello</p><script>let parentAccess=false;try{parentAccess=!!parent.document.body}catch{}parent.postMessage({probe:true,parentAccess,node:typeof process,require:typeof require},"*");</script>';
  try {
    await mount();
    await expect
      .poll(() => reports)
      .toEqual([{ probe: true, parentAccess: false, node: "undefined", require: "undefined" }]);
    expect(document.querySelector('iframe[title="HTML widget"]')?.getAttribute("sandbox")).toBe(
      "allow-scripts",
    );
    expect(
      document.querySelector<HTMLIFrameElement>('iframe[title="HTML widget"]')?.srcdoc,
    ).toContain("default-src 'none'");
  } finally {
    window.removeEventListener("message", receive);
  }
});
it("opens links externally without navigating the parent", async () => {
  source =
    '<a style="display:block;height:120px;width:100%" href="https://example.test/review">Hello</a>';
  await mount();
  await page.getByTitle("HTML widget", { exact: true }).click();
  await expect.poll(() => api.openExternal.mock.calls).toEqual([["https://example.test/review"]]);
});
it("opens rendered images through the existing image viewer", async () => {
  const image = vi.fn();
  const src =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  source = `<p style="display:none">Hello</p><img alt="Diagram" style="display:block;height:120px;width:100%" src="${src}">`;
  await mount(image);
  await page.getByTitle("HTML widget", { exact: true }).click();
  await expect.poll(() => image.mock.calls.length).toBe(1);
  expect(image.mock.calls[0]![0].images[0]).toMatchObject({
    src,
    name: "Diagram",
    mimeType: "image/png",
  });
});
it("supports fullscreen zoom and returns inline when Escape is pressed inside the frame", async () => {
  await mount();
  await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.element(page.getByText("110%", { exact: true })).toBeVisible();
  await page.getByTitle("HTML widget", { exact: true }).click();
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => page.getByRole("dialog").query()).toBeNull();
  await expect.element(page.getByRole("button", { name: "Fullscreen", exact: true })).toBeVisible();
});

it("ignores forged page commands and extra channel handshakes", async () => {
  source = `<p>Hello</p><script>parent.postMessage({f5HtmlRender:__f5Bridge,type:'link',value:'https://forged.test/'},'*');const fake=new MessageChannel();parent.postMessage({f5HtmlRender:__f5Bridge,type:'connect'},'*',[fake.port2]);fake.port1.postMessage({f5HtmlRender:__f5Bridge,type:'link',value:'https://forged.test/'});</script>`;
  await mount();
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  expect(api.openExternal).not.toHaveBeenCalled();
});

it("forwards configured trusted shortcuts using captured native key getters", async () => {
  api.bindings = [
    {
      command: "commandPalette.toggle",
      shortcut: {
        key: "k",
        ctrlKey: true,
        metaKey: false,
        modKey: false,
        shiftKey: false,
        altKey: false,
      },
    },
  ];
  source = `<p>Hello</p><script>Object.defineProperty(KeyboardEvent.prototype,'key',{get(){return 'Delete'}});</script>`;
  const keys: string[] = [];
  const receive = (event: KeyboardEvent) => {
    if (!event.isTrusted) keys.push(event.key);
  };
  window.addEventListener("keydown", receive);
  try {
    await mount();
    await page.getByTitle("HTML widget", { exact: true }).click();
    await userEvent.keyboard("{Control>}k{/Control}");
    await expect.poll(() => keys).toContain("k");
    expect(keys).not.toContain("Delete");
  } finally {
    window.removeEventListener("keydown", receive);
  }
});
