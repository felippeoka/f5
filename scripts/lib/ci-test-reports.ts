import { join, resolve } from "node:path";
import type { InlineConfig } from "vitest/node";

export interface SuiteIdentity {
  packageName: string;
  event: string;
}

const encode = (value: string) => {
  if (!value.trim() || value === "." || value === "..")
    throw new Error("Invalid CI suite identity");
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
};

export function reportPath(identity: SuiteIdentity): string {
  return join(encode(identity.packageName), encode(identity.event), "results.json");
}

export function ciTestReports(env: NodeJS.ProcessEnv = process.env): InlineConfig {
  if (!env.F5_CI_REPORT_DIR) return {};
  const packageName = env.F5_CI_SUITE_ID ? "suites" : env.npm_package_name;
  const event = env.F5_CI_SUITE_ID || env.npm_lifecycle_event;
  if (!packageName || !event) {
    throw new Error(
      "CI reports require npm_package_name and npm_lifecycle_event, or F5_CI_SUITE_ID",
    );
  }
  const json = resolve(env.F5_CI_REPORT_DIR, reportPath({ packageName, event }));
  return {
    reporters: ["default", "junit", "json"],
    outputFile: { json, junit: json.replace(/\.json$/, ".xml") },
  };
}
