/** Reject oversized/deep JSON before allocating its full serialized form. */
export function stringifyWithinBytes(value: unknown, limit: number): string | undefined {
  if (!Number.isSafeInteger(limit) || limit < 0) return undefined;
  let bytes = 0;
  let nodes = 0;
  const seen = new Set<object>();
  const encoder = new TextEncoder();
  const add = (amount: number) => (bytes += amount) <= limit;
  const text = (value: string) =>
    value.length <= limit - bytes && add(encoder.encode(JSON.stringify(value)).byteLength);
  const visit = (value: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 32) return false;
    if (value === null) return add(4);
    if (typeof value === "string") return text(value);
    if (typeof value === "boolean") return add(value ? 4 : 5);
    if (typeof value === "number") return add((JSON.stringify(value) ?? "null").length);
    if (typeof value !== "object" || seen.has(value)) return false;
    const array = Array.isArray(value);
    if (
      !array &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      return false;
    seen.add(value);
    if (!add(2)) return false;
    if (array) {
      if (value.length > 10_000 - nodes) return false;
      for (let index = 0; index < value.length; index++) {
        if (
          (index > 0 && !add(1)) ||
          !visit(value[index] === undefined ? null : value[index], depth + 1)
        )
          return false;
      }
    } else {
      let first = true;
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue;
        const child = (value as Record<string, unknown>)[key];
        if (child === undefined) continue;
        if ((!first && !add(1)) || !text(key) || !add(1) || !visit(child, depth + 1)) return false;
        first = false;
      }
    }
    seen.delete(value);
    return true;
  };
  try {
    return visit(value, 0) ? JSON.stringify(value) : undefined;
  } catch {
    return undefined;
  }
}
