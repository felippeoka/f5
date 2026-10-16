export interface CodexModelPages {
  readonly entries: ReadonlyArray<Record<string, unknown>>;
  readonly complete: boolean;
  readonly anomaly?: string;
}

/** Read a bounded catalog, preserving useful rows when older CLIs or paging fail. */
export async function readCodexModelPages(
  request: (params: Record<string, unknown>) => Promise<unknown>,
  { maxPages = 10 }: { maxPages?: number } = {},
): Promise<CodexModelPages> {
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let includeHidden = true;
  let compatible = true;
  for (let page = 0; page < maxPages; page++) {
    let response: unknown;
    try {
      response = await request({
        ...(includeHidden ? { includeHidden: true } : {}),
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (page > 0) return { entries, complete: false, anomaly: "model/list page request failed" };
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (!includeHidden || (code !== -32601 && code !== -32602)) throw error;
      includeHidden = false;
      compatible = false;
      response = await request({});
    }
    if (
      !response ||
      typeof response !== "object" ||
      !("data" in response) ||
      !Array.isArray(response.data)
    )
      return { entries, complete: false, anomaly: "Malformed model/list data" };
    for (const row of response.data) {
      if (!row || typeof row !== "object" || Array.isArray(row))
        return { entries, complete: false, anomaly: "Malformed model/list row" };
      const identifier =
        "model" in row && typeof row.model === "string" && row.model.trim()
          ? row.model
          : "id" in row && typeof row.id === "string" && row.id.trim()
            ? row.id
            : undefined;
      if (!identifier)
        return { entries, complete: false, anomaly: "model/list row has no usable identifier" };
      entries.push(row as Record<string, unknown>);
    }
    const next = "nextCursor" in response ? response.nextCursor : undefined;
    if (next === null)
      return {
        entries,
        complete: compatible,
        ...(!compatible ? { anomaly: "includeHidden unsupported" } : {}),
      };
    if (typeof next !== "string" || !next || seen.has(next))
      return { entries, complete: false, anomaly: "Invalid or repeated model/list cursor" };
    seen.add(next);
    cursor = next;
  }
  return { entries, complete: false, anomaly: "model/list page limit reached" };
}
