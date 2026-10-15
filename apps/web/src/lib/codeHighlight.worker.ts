import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import type {
  CodeHighlightWorkerRequest,
  CodeHighlightWorkerResponse,
} from "./codeHighlightWorkerClient";

// Grammars and themes are resolved on the main thread and sent once per
// worker, so this bundle carries only Shiki's core, not every grammar loader.
// Jobs run one at a time.
const queue: Array<Extract<CodeHighlightWorkerRequest, { type: "highlight" }>> = [];
let running = false;
let highlighter: Promise<HighlighterCore> | null = null;

function respond(response: CodeHighlightWorkerResponse): void {
  self.postMessage(response);
}

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighter;
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const job = queue.shift()!;
      try {
        const instance = await getHighlighter();
        for (const theme of job.resolvedThemes) {
          if (!instance.getLoadedThemes().includes(theme.name)) instance.loadThemeSync(theme);
        }
        for (const language of job.resolvedLanguages) {
          if (!instance.getLoadedLanguages().includes(language.name)) {
            instance.loadLanguageSync(language.data);
          }
        }
        const html = instance.codeToHtml(job.code, { lang: job.language, theme: job.theme });
        respond({ type: "result", id: job.id, html });
      } catch (error) {
        respond({
          type: "error",
          id: job.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    running = false;
  }
}

self.addEventListener("message", (event: MessageEvent<CodeHighlightWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    const index = queue.findIndex((job) => job.id === request.id);
    if (index !== -1) queue.splice(index, 1);
    return;
  }
  queue.push(request);
  void drain();
});
