import * as path from "node:path";
import { defineConfig } from "vitest/config";

import { ciTestReports } from "./scripts/lib/ci-test-reports";

export default defineConfig({
  test: ciTestReports(),
  resolve: {
    alias: [
      {
        find: /^@t3tools\/contracts$/,
        replacement: path.resolve(import.meta.dirname, "./packages/contracts/src/index.ts"),
      },
    ],
  },
});
