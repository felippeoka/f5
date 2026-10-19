import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { Utf8Lines } from "@t3tools/shared/utf8Lines";

/** Node source wiring stays server-side; the decoder/framer is shared with ACP. */
export class ProviderLineReader extends EventEmitter<{ line: [string]; close: [] }> {
  private readonly lines = new Utf8Lines();
  private closed = false;
  constructor(private readonly source: Readable) {
    super();
    source.on("data", this.data);
    source.on("end", this.end);
    source.on("close", this.end);
  }
  private readonly data = (chunk: Buffer | string) => {
    for (const line of this.lines.push(chunk)) this.emit("line", line);
  };
  private readonly end = () => {
    if (this.closed) return;
    for (const line of this.lines.finish()) this.emit("line", line);
    this.close();
  };
  /** Flush an already received final fragment before releasing a draining source. */
  finish(): void {
    this.end();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.source.off("data", this.data);
    this.source.off("end", this.end);
    this.source.off("close", this.end);
    this.emit("close");
  }
}
