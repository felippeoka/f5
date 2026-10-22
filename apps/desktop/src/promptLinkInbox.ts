import {
  PROMPT_LINK_DEV_SCHEME,
  PROMPT_LINK_SCHEME,
  promptLinkAppPath,
} from "@t3tools/shared/promptLinks";

/** Development builds register their own scheme so they never take links meant for F5. */
export function promptLinkSchemeFor(isDevelopment: boolean): string {
  return isDevelopment ? PROMPT_LINK_DEV_SCHEME : PROMPT_LINK_SCHEME;
}

/**
 * The arguments `setAsDefaultProtocolClient` needs. An unpackaged Electron is launched with the
 * app's entry script, which the OS must pass back or the link would open a bare Electron.
 */
export function protocolClientRegistration(input: {
  readonly defaultApp: boolean;
  readonly execPath: string;
  readonly entryScript: string | undefined;
}): { readonly path: string; readonly args: readonly string[] } | null {
  if (!input.defaultApp) return null;
  return input.entryScript ? { path: input.execPath, args: [input.entryScript] } : null;
}

/** A prompt link Windows and Linux pass on the command line of a second launch. */
export function promptLinkInArgv(argv: readonly string[], scheme: string): string | null {
  return argv.find((arg) => arg.toLowerCase().startsWith(`${scheme}:`)) ?? null;
}

const MAX_PENDING_LINKS = 10;

/**
 * Prompt links wait here until a renderer takes them, so a link that arrives before the window
 * has loaded (a cold start opened by the link) is not lost.
 */
export class PromptLinkInbox {
  #pending: string[] = [];

  constructor(private readonly scheme: string) {}

  /** Queues a link this build opens. Returns false for anything that is not one. */
  receive(url: string): boolean {
    if (!url.toLowerCase().startsWith(`${this.scheme}:`)) return false;
    if (promptLinkAppPath(url) === null) return false;
    this.#pending.push(url);
    if (this.#pending.length > MAX_PENDING_LINKS) this.#pending.shift();
    return true;
  }

  take(): readonly string[] {
    const pending = this.#pending;
    this.#pending = [];
    return pending;
  }
}
