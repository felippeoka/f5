/** Synchronous notification admission. Native stdout and RPC responses never wait here. */
export class NotificationAdmission {
  private entries = 0;
  private bytes = 0;
  private controls = 0;
  private controlBytes = 0;
  private readonly admitted = new Map<symbol, number>();
  constructor(private readonly limits = { entries: 1024, bytes: 32 * 1024 * 1024, controls: 64 }) {}

  reserve(bytes: number, control = false): (() => void) | undefined {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return undefined;
    if (control ? this.controls >= this.limits.controls : this.entries >= this.limits.entries)
      return undefined;
    // A valid large native notification may occupy the queue alone. This is
    // an admission bound, never a Codex stdout frame-size limit.
    const laneEntries = control ? this.controls : this.entries;
    const laneBytes = control ? this.controlBytes : this.bytes;
    const byteLimit = control ? Math.min(this.limits.bytes, 1024 * 1024) : this.limits.bytes;
    if (laneEntries > 0 && laneBytes + bytes > byteLimit) return undefined;
    if (control) this.controls++;
    else this.entries++;
    if (control) this.controlBytes += bytes;
    else this.bytes += bytes;
    const id = Symbol();
    this.admitted.set(id, Date.now());
    return () => {
      if (!this.admitted.delete(id)) return;
      if (control) this.controls--;
      else this.entries--;
      if (control) this.controlBytes -= bytes;
      else this.bytes -= bytes;
    };
  }
  snapshot() {
    return {
      entries: this.entries,
      controls: this.controls,
      bytes: this.bytes + this.controlBytes,
      oldestAgeMs: this.admitted.size
        ? Math.max(0, Date.now() - Math.min(...this.admitted.values()))
        : 0,
    };
  }
}
