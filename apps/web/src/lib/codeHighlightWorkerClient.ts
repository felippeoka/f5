import type { resolveLanguage, resolveTheme } from "@pierre/diffs";

import type { DiffThemeName } from "./diffRendering";

type ResolvedLanguage = Awaited<ReturnType<typeof resolveLanguage>>;
type ResolvedTheme = Awaited<ReturnType<typeof resolveTheme>>;

export type CodeHighlightWorkerRequest =
  | {
      readonly type: "highlight";
      readonly id: number;
      readonly code: string;
      readonly language: string;
      readonly theme: DiffThemeName;
      readonly resolvedLanguages: ResolvedLanguage[];
      readonly resolvedThemes: ResolvedTheme[];
    }
  | { readonly type: "cancel"; readonly id: number };

export type CodeHighlightWorkerResponse =
  | { readonly type: "result"; readonly id: number; readonly html: string }
  | { readonly type: "error"; readonly id: number; readonly message: string }
  /** A cancelled job's assets were loaded; it was not highlighted. */
  | { readonly type: "cancelled"; readonly id: number };

/**
 * Grammars one worker may hold before it is replaced, which bounds the memory
 * retained by long sessions that touch many languages.
 */
export const CODE_HIGHLIGHT_WORKER_MAX_LANGUAGES = 16;
const CODE_HIGHLIGHT_JOB_TIMEOUT_MS = 20_000;
/** After this many worker crashes in a row, large blocks stay plain text. */
const CODE_HIGHLIGHT_WORKER_MAX_FAILURES = 3;

export type CodeHighlightWorkerFactory = () => Worker;

const defaultWorkerFactory: CodeHighlightWorkerFactory = () =>
  new Worker(new URL("./codeHighlight.worker.ts", import.meta.url), { type: "module" });

interface PendingJob {
  readonly resolve: (html: string) => void;
  readonly reject: (error: Error) => void;
}

interface WorkerSlot {
  readonly worker: Worker;
  /** Grammars and themes sent to the worker; un-recorded if loading them fails. */
  readonly languages: Set<string>;
  readonly themes: Set<string>;
  readonly pending: Map<number, PendingJob>;
  /** Assets each unanswered job carried, including cancelled jobs. */
  readonly sentAssets: Map<number, { languages: string[]; themes: string[] }>;
}

let workerFactory: CodeHighlightWorkerFactory = defaultWorkerFactory;
let slot: WorkerSlot | null = null;
let nextJobId = 1;
let consecutiveFailures = 0;

function retireSlot(target: WorkerSlot, error: Error): void {
  if (slot === target) slot = null;
  target.worker.terminate();
  for (const job of target.pending.values()) job.reject(error);
  target.pending.clear();
}

function createSlot(): WorkerSlot {
  const worker = workerFactory();
  const created: WorkerSlot = {
    worker,
    languages: new Set(),
    themes: new Set(),
    pending: new Map(),
    sentAssets: new Map(),
  };
  worker.addEventListener("message", (event: MessageEvent<CodeHighlightWorkerResponse>) => {
    const response = event.data;
    const sent = created.sentAssets.get(response.id);
    created.sentAssets.delete(response.id);
    if (response.type === "error" && sent) {
      // The worker may not have loaded them; send them again next time.
      for (const language of sent.languages) created.languages.delete(language);
      for (const theme of sent.themes) created.themes.delete(theme);
    }
    const job = created.pending.get(response.id);
    if (!job) return;
    created.pending.delete(response.id);
    consecutiveFailures = 0;
    if (response.type === "result") {
      job.resolve(response.html);
    } else if (response.type === "error") {
      job.reject(new Error(response.message));
    }
  });
  worker.addEventListener("error", (event) => {
    event.preventDefault();
    consecutiveFailures += 1;
    retireSlot(created, new Error(event.message || "Code highlight worker failed."));
  });
  return created;
}

function acquireSlot(language: string): WorkerSlot {
  if (
    slot &&
    !slot.languages.has(language) &&
    slot.languages.size >= CODE_HIGHLIGHT_WORKER_MAX_LANGUAGES &&
    slot.pending.size === 0
  ) {
    retireSlot(slot, new Error("Code highlight worker recycled."));
  }
  slot ??= createSlot();
  return slot;
}

async function resolveAssets(language: string, theme: DiffThemeName) {
  const diffs = await import("@pierre/diffs");
  let resolvedLanguage: ResolvedLanguage | null = null;
  let effectiveLanguage = language;
  if (language !== "text" && language !== "ansi") {
    try {
      resolvedLanguage = await diffs.resolveLanguage(
        language as Parameters<typeof diffs.resolveLanguage>[0],
      );
    } catch {
      // Unsupported language: highlight as plain text instead of failing.
      effectiveLanguage = "text";
    }
  }
  const resolvedTheme = await diffs.resolveTheme(theme);
  return { effectiveLanguage, resolvedLanguage, resolvedTheme };
}

function abortError(): Error {
  const error = new Error("Code highlighting was cancelled.");
  error.name = "AbortError";
  return error;
}

/**
 * Highlights `code` to HTML in a web worker. Rejects with an `AbortError` when
 * `signal` aborts, and with an error when the worker fails or times out; the
 * caller renders plain text in either case.
 */
export async function highlightCodeInWorker(input: {
  code: string;
  language: string;
  theme: DiffThemeName;
  signal?: AbortSignal;
}): Promise<string> {
  if (typeof Worker !== "function") throw new Error("Web workers are unavailable.");
  if (consecutiveFailures >= CODE_HIGHLIGHT_WORKER_MAX_FAILURES) {
    throw new Error("Code highlight worker is disabled after repeated failures.");
  }
  if (input.signal?.aborted) throw abortError();
  const { effectiveLanguage, resolvedLanguage, resolvedTheme } = await resolveAssets(
    input.language,
    input.theme,
  );
  if (input.signal?.aborted) throw abortError();

  // Slots record grammars by resolved name, so aliases like `ts` match `typescript`.
  const target = acquireSlot(resolvedLanguage?.name ?? effectiveLanguage);
  const resolvedLanguages =
    resolvedLanguage && !target.languages.has(resolvedLanguage.name) ? [resolvedLanguage] : [];
  const resolvedThemes = target.themes.has(input.theme) ? [] : [resolvedTheme];
  for (const entry of resolvedLanguages) target.languages.add(entry.name);
  for (const _theme of resolvedThemes) target.themes.add(input.theme);

  const id = nextJobId++;
  target.sentAssets.set(id, {
    languages: resolvedLanguages.map((entry) => entry.name),
    themes: resolvedThemes.length > 0 ? [input.theme] : [],
  });
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (!target.pending.delete(id)) return;
      cleanup();
      target.worker.postMessage({ type: "cancel", id } satisfies CodeHighlightWorkerRequest);
      reject(abortError());
    };
    const timeout = setTimeout(() => {
      if (!target.pending.has(id)) return;
      // A job this slow means the worker is stuck; replace it.
      consecutiveFailures += 1;
      retireSlot(target, new Error("Code highlighting timed out."));
    }, CODE_HIGHLIGHT_JOB_TIMEOUT_MS);
    target.pending.set(id, {
      resolve: (html) => {
        cleanup();
        resolve(html);
      },
      reject: (error) => {
        cleanup();
        reject(error);
      },
    });
    input.signal?.addEventListener("abort", onAbort, { once: true });
    target.worker.postMessage({
      type: "highlight",
      id,
      code: input.code,
      language: effectiveLanguage,
      theme: input.theme,
      resolvedLanguages,
      resolvedThemes,
    } satisfies CodeHighlightWorkerRequest);
  });
}

export function setCodeHighlightWorkerFactoryForTests(
  factory: CodeHighlightWorkerFactory | null,
): void {
  if (slot) retireSlot(slot, new Error("Code highlight worker reset."));
  workerFactory = factory ?? defaultWorkerFactory;
  consecutiveFailures = 0;
}
