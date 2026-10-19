import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import type { ServerDraft } from "./mcpDraft";

export function McpArgumentFields({
  draft,
  onChange,
}: {
  readonly draft: ServerDraft;
  readonly onChange: (patch: Partial<ServerDraft>) => void;
}) {
  const args: string[] =
    draft.args === ""
      ? []
      : draft.argsFormat === "json"
        ? (JSON.parse(draft.args) as string[])
        : draft.args.split(/\r?\n/u);
  const update = (next: string[]) => onChange({ args: JSON.stringify(next), argsFormat: "json" });
  const move = (index: number, offset: number) => {
    const next = [...args];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    update(next);
  };
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium">Arguments</p>
      <p className="text-xs text-muted-foreground">
        Passed in order. Empty values, whitespace, and line breaks are preserved.
      </p>
      {args.map((arg, index) => (
        <div key={index} className="flex items-start gap-2">
          <span className="pt-2 text-xs text-muted-foreground">{index + 1}</span>
          <Textarea
            aria-label={`Argument ${index + 1}`}
            value={arg}
            className="min-h-9 font-mono"
            onChange={(event) =>
              update(args.map((entry, i) => (i === index ? event.target.value : entry)))
            }
          />
          <Button
            size="xs"
            variant="outline"
            aria-label={`Move argument ${index + 1} up`}
            disabled={index === 0}
            onClick={() => move(index, -1)}
          >
            ↑
          </Button>
          <Button
            size="xs"
            variant="outline"
            aria-label={`Move argument ${index + 1} down`}
            disabled={index === args.length - 1}
            onClick={() => move(index, 1)}
          >
            ↓
          </Button>
          <Button
            size="xs"
            variant="outline"
            aria-label={`Remove argument ${index + 1}`}
            onClick={() => update(args.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button size="xs" variant="outline" onClick={() => update([...args, ""])}>
        Add argument
      </Button>
    </div>
  );
}
