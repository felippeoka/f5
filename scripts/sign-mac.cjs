const { createRequire } = require("node:module");
const { resolve } = require("node:path");

function perFileOptions(options, file) {
  const inherited = options.optionsForFile?.(file) ?? {};
  if (!file.replaceAll("\\", "/").endsWith("/Contents/Resources/native/f5-computer-helper"))
    return inherited;
  return {
    ...inherited,
    entitlements: resolve(
      __dirname,
      "../apps/desktop/resources/entitlements.computer-helper.plist",
    ),
    hardenedRuntime: true,
  };
}
exports.perFileOptions = perFileOptions;
exports.default = async (options) => {
  // Resolve the exact osx-sign version owned by the pinned electron-builder.
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  const { signAsync } = libRequire("@electron/osx-sign");
  return signAsync({
    ...options,
    preAutoEntitlements: false,
    optionsForFile: (file) => perFileOptions(options, file),
  });
};
