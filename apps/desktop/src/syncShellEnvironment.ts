import { readEnvironmentFromLoginShell, ShellEnvironmentReader } from "@t3tools/shared/shell";
import {
  ensureWindowsPathHydrated,
  type WindowsRegistryPathReader,
} from "@t3tools/shared/windowsPath";

const CA_TRUST_NAMES = ["SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;

const LOCALE_NAMES = ["LANG", "LC_ALL", "LC_CTYPE"] as const;

export function syncShellEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    platform?: NodeJS.Platform;
    readEnvironment?: ShellEnvironmentReader;
    readWindowsRegistryPaths?: WindowsRegistryPathReader;
    windowsPathExists?: (path: string) => Promise<boolean>;
    warn?: (message: string) => void;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return ensureWindowsPathHydrated(env, {
      platform,
      ...(options.readWindowsRegistryPaths
        ? { readRegistryPaths: options.readWindowsRegistryPaths }
        : {}),
      ...(options.windowsPathExists ? { pathExists: options.windowsPathExists } : {}),
      warn: options.warn ?? ((message) => console.warn(`[environment] ${message}`)),
    }).then(() => undefined);
  }
  if (platform !== "darwin") return Promise.resolve();

  try {
    const shell = env.SHELL ?? "/bin/zsh";
    const shellEnvironment = (options.readEnvironment ?? readEnvironmentFromLoginShell)(shell, [
      "PATH",
      "SSH_AUTH_SOCK",
      ...LOCALE_NAMES,
      ...CA_TRUST_NAMES,
    ]);

    for (const name of CA_TRUST_NAMES)
      if (!env[name]?.trim() && shellEnvironment[name]?.trim()) env[name] = shellEnvironment[name];

    // Locale categories form a precedence group; never override an inherited choice.
    if (LOCALE_NAMES.every((name) => !env[name]?.trim())) {
      for (const name of LOCALE_NAMES) {
        if (shellEnvironment[name]?.trim()) env[name] = shellEnvironment[name];
      }
    }

    if (shellEnvironment.PATH) {
      env.PATH = shellEnvironment.PATH;
    }

    if (!env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }
  } catch {
    // Keep inherited environment if shell lookup fails.
  }
  if (LOCALE_NAMES.every((name) => !env[name]?.trim())) env.LC_CTYPE = "en_US.UTF-8";
  return Promise.resolve();
}
