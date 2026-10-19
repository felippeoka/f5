/**
 * Repo-relative globs whose uncommitted changes Storage cleanup may discard.
 * `**` crosses directories, `*` and `?` stay within one segment, and a
 * trailing `/` matches the directory and everything under it.
 */
function globToRegExp(pattern: string): RegExp {
  const directory = pattern.endsWith("/");
  const body = pattern.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  let source = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char === "*") {
      if (body[index + 1] === "*") {
        const slashAfter = body[index + 2] === "/";
        // `**/` also matches zero directories.
        source += slashAfter ? "(?:.*/)?" : ".*";
        index += slashAfter ? 2 : 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}${directory ? "(?:/.*)?" : ""}$`);
}

/** Paths that are not covered by any disposable pattern; empty means all may be discarded. */
export function nonDisposablePaths(
  paths: ReadonlyArray<string>,
  patterns: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const matchers = patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map(globToRegExp);
  return paths.filter((path) => {
    // Untracked directories are reported with a trailing slash.
    const normalized = path.replace(/\/+$/, "");
    return !matchers.some((matcher) => matcher.test(normalized) || matcher.test(`${normalized}/`));
  });
}
