export const COMPUTER_ACTION_VERB: Record<string, readonly [ongoing: string, done: string]> = {
  wait: ["Waiting", "Waited"],
  requestForeground: ["Requesting foreground", "Requested foreground"],
  screenshot: ["Taking a screenshot", "Took a screenshot"],
  zoom: ["Zooming in", "Zoomed in"],
  inspect: ["Reading the screen", "Read the screen"],
  click: ["Clicking", "Clicked"],
  move: ["Moving the pointer", "Moved the pointer"],
  drag: ["Dragging", "Dragged"],
  scroll: ["Scrolling", "Scrolled"],
  type: ["Typing", "Typed"],
  key: ["Pressing a key", "Pressed a key"],
  elementAction: ["Using a control", "Used a control"],
  openApp: ["Opening app", "Opened app"],
  activateApp: ["Switching app", "Switched app"],
  listApps: ["Listing apps", "Listed apps"],
  resolveApps: ["Finding apps", "Found apps"],
  status: ["Checking status", "Checked status"],
  requestAccess: ["Requesting access", "Requested access"],
};

const TOOL_OPS: Record<string, string> = {
  list_apps: "listApps",
  request_access: "requestAccess",
  request_foreground: "requestForeground",
  element_action: "elementAction",
  open_app: "openApp",
  activate_app: "activateApp",
};
/** Identity/provenance is checked by ingestion; this function only chooses wording. */
export function computerToolHeading(
  toolName: string | undefined,
  status: string | undefined,
): string | undefined {
  const name = toolName?.split("__").at(-1);
  if (!name?.startsWith("computer_")) return undefined;
  const suffix = name.slice("computer_".length);
  const words = COMPUTER_ACTION_VERB[TOOL_OPS[suffix] ?? suffix];
  if (!words) return undefined;
  return status === "inProgress" || status === "running" || status === "started"
    ? `${words[0]}…`
    : status === "failed" || status === "error"
      ? `${words[0]} failed`
      : words[1];
}
