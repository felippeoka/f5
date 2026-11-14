export interface MarkdownContinuation {
  readonly removeBefore: number;
  readonly text: string;
}

/** Continue Markdown on an intentional newline without changing existing text. */
export function markdownContinuation(value: string, cursor: number): MarkdownContinuation | null {
  const before = value.slice(0, cursor);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  let fence: string | undefined;
  for (const previous of before.split("\n").slice(0, -1)) {
    const match = previous.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (!match) continue;
    if (!fence) fence = match[1];
    else if (match[1]![0] === fence[0] && match[1]!.length >= fence.length) fence = undefined;
  }
  if (fence) return null;
  const quote = line.match(/^([ \t]*(?:>[ \t]*)+)/)?.[0] ?? "";
  const body = line.slice(quote.length);
  const list = body.match(/^([ \t]*)(?:(\d+)([.)])|([-+*]))([ \t]+|$)(.*)$/);
  if (list) {
    const [, indent = "", number, delimiter, bullet, spacing = "", content = ""] = list;
    const task = content.match(/^\[[ xX]\](?:[ \t]+|$)(.*)$/);
    const empty = task ? !task[1]?.trim() : !content.trim();
    if (empty && !value.slice(cursor).split("\n")[0]?.trim() && (spacing.length > 0 || task)) {
      return { removeBefore: line.length, text: quote + indent };
    }
    const nextNumber = number ? Number(number) + 1 : undefined;
    if (nextNumber !== undefined && !Number.isSafeInteger(nextNumber)) return null;
    const marker = number ? `${nextNumber}${delimiter}` : bullet;
    return { removeBefore: 0, text: `\n${quote}${indent}${marker} ${task ? "[ ] " : ""}` };
  }
  if (quote) {
    return body.trim()
      ? { removeBefore: 0, text: "\n" + quote }
      : { removeBefore: line.length, text: "" };
  }
  const indent = line.match(/^[ \t]+/)?.[0];
  return indent ? { removeBefore: 0, text: "\n" + indent } : null;
}
