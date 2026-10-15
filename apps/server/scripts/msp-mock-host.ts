/**
 * Scripted Muse Session Protocol host over stdio, for transport and
 * lifecycle tests. Serves `MockMspHost` defaults; environment switches cover
 * the process-level cases:
 *
 * - `MSP_MOCK_STDERR`: text written to stderr at startup.
 * - `MSP_MOCK_STAY_ALIVE=1`: keep running after stdin closes.
 * - `MSP_MOCK_IGNORE_SIGTERM=1`: ignore SIGTERM (forces SIGKILL escalation).
 * - `MSP_MOCK_FINGERPRINT`: schema fingerprint to advertise.
 */
import { MockMspHost } from "../src/provider/msp/testing/mockMspHost.ts";

const host = new MockMspHost(
  process.env.MSP_MOCK_FINGERPRINT ? { fingerprint: process.env.MSP_MOCK_FINGERPRINT } : {},
);

if (process.env.MSP_MOCK_STDERR) process.stderr.write(process.env.MSP_MOCK_STDERR);
if (process.env.MSP_MOCK_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => undefined);

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  void host.transport.write(chunk);
});
process.stdin.on("end", () => {
  if (process.env.MSP_MOCK_STAY_ALIVE !== "1") process.exit(0);
  setInterval(() => undefined, 1_000);
});

void (async () => {
  for await (const chunk of host.transport.incoming) process.stdout.write(chunk);
})();
