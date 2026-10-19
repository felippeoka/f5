import { useMemo } from "react";
import type { HtmlRenderTheme } from "@t3tools/shared/htmlRender";
import { useTheme } from "./useTheme";

export function useHtmlRenderTheme(): HtmlRenderTheme {
  const { resolvedTheme } = useTheme();
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const variables = Object.fromEntries(
      [
        "--background",
        "--foreground",
        "--muted",
        "--muted-foreground",
        "--primary",
        "--primary-foreground",
        "--border",
        "--card",
        "--card-foreground",
      ].map((key) => [key, style.getPropertyValue(key).trim()]),
    );
    return { appearance: resolvedTheme, variables };
  }, [resolvedTheme]);
}
