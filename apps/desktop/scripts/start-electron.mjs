import { spawn } from "node:child_process";
import { constants } from "node:os";

import { desktopDir, resolveElectronPath } from "./electron-launcher.mjs";

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(resolveElectronPath(), ["dist-electron/main.js"], {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    // Report the signal through the shell exit-code convention. Re-raising a fault signal
    // like SIGSEGV on ourselves makes Bun's crash handler blame Bun for Electron's crash.
    console.error(`Electron exited with ${signal}`);
    process.exit(128 + (constants.signals[signal] ?? 0));
  }
  process.exit(code ?? 0);
});
