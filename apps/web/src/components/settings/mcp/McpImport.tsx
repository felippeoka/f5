import type { Dispatch, SetStateAction } from "react";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";

export function McpImport({
  importText,
  setImportText,
  importError,
  setImportError,
  isSavingConfig,
  importServers,
}: {
  readonly importText: string;
  readonly setImportText: Dispatch<SetStateAction<string>>;
  readonly importError: string | null;
  readonly setImportError: Dispatch<SetStateAction<string | null>>;
  readonly isSavingConfig: boolean;
  readonly importServers: () => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-4">
      <div>
        <p className="text-sm font-medium text-foreground">Import configuration</p>
        <p className="text-xs text-muted-foreground">
          Paste Claude JSON or Codex <code>config.toml</code> MCP sections into the selected scope.
          SDK entries are skipped. Codex TOML import supports basic sectioned key/value data only.
        </p>
      </div>
      <Textarea
        value={importText}
        onChange={(event) => {
          setImportText(event.target.value);
          setImportError(null);
        }}
        className="min-h-36 font-mono text-xs"
        placeholder='{"mcpServers":{"filesystem":{"type":"stdio","command":"npx","args":["@modelcontextprotocol/server-filesystem"]}}}'
      />
      <div className="flex items-center justify-between gap-3">
        {importError ? (
          <p className="text-xs text-destructive">{importError}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Imported servers replace matching names and use the same validation as manual edits.
            Multi-line TOML strings, inline tables, and arrays of tables are ignored.
          </p>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={importServers}
          disabled={!importText.trim() || isSavingConfig}
        >
          Import
        </Button>
      </div>
    </div>
  );
}
