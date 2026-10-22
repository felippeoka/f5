import type { ThreadId } from "@t3tools/contracts";
import { parseThreadLinkPrompt, withoutPromptLinkParams } from "@t3tools/shared/promptLinks";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { toastManager } from "../ui/toast";
import { placeLinkedPrompt } from "./linkedPrompt";

/**
 * Handles `f5://thread/<id>?prompt=…`: once the thread is loaded, the prompt goes into its
 * composer and the link's parameters leave the URL so a reload does not offer it again.
 */
export function useThreadLinkPrompt(threadId: ThreadId, ready: boolean): void {
  const pathname = useLocation({ select: (location) => location.pathname });
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const navigate = useNavigate();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || !new URLSearchParams(searchStr).has("prompt")) return;
    const key = `${threadId}${searchStr}`;
    if (handled.current === key) return;
    handled.current = key;
    const parsed = parseThreadLinkPrompt(searchStr);
    if (!parsed.ok) {
      toastManager.add({
        type: "warning",
        title: "F5 could not open this link",
        description: parsed.error,
      });
    } else if (parsed.value !== null) {
      placeLinkedPrompt(threadId, parsed.value);
    }
    void navigate({ href: `${pathname}${withoutPromptLinkParams(searchStr)}`, replace: true });
  }, [navigate, pathname, ready, searchStr, threadId]);
}
