import { DEFAULT_RELEASE_REPOSITORY } from "./releaseRepository";

declare const __F5_RELEASE_REPOSITORY__: string | undefined;

/** Validated in `astro.config.mjs` at build time. */
export const RELEASE_REPOSITORY =
  typeof __F5_RELEASE_REPOSITORY__ === "string"
    ? __F5_RELEASE_REPOSITORY__
    : DEFAULT_RELEASE_REPOSITORY;

export const REPOSITORY_URL = `https://github.com/${RELEASE_REPOSITORY}`;
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;

const CACHE_KEY_PREFIX = "f5-latest-release:v1:";
export const RELEASE_CACHE_TTL_MS = 10 * 60 * 1000;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
}

interface CachedRelease {
  fetchedAt: number;
  release: Release;
}

type ReleaseStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isGitHubUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "github.com" || url.hostname.endsWith(".githubusercontent.com"))
    );
  } catch {
    return false;
  }
}

/**
 * Accepts only the fields the pages use. Assets with unexpected names or
 * non-GitHub download URLs are dropped rather than linked.
 */
export function parseRelease(value: unknown): Release | null {
  if (!isRecord(value)) return null;
  const { tag_name: tagName, html_url: htmlUrl, assets } = value;
  if (typeof tagName !== "string" || tagName.length === 0 || tagName.length > 128) return null;
  if (!isGitHubUrl(htmlUrl) || !Array.isArray(assets)) return null;
  const validAssets = assets.flatMap((asset): ReleaseAsset[] => {
    if (!isRecord(asset)) return [];
    const { name, browser_download_url: downloadUrl } = asset;
    if (typeof name !== "string" || !/^[\w.+-]{1,200}$/.test(name)) return [];
    if (!isGitHubUrl(downloadUrl)) return [];
    return [{ name, browser_download_url: downloadUrl }];
  });
  return { tag_name: tagName, html_url: htmlUrl, assets: validAssets };
}

function readCachedRelease(storage: ReleaseStorage, key: string, now: number): Release | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const cached: unknown = JSON.parse(raw);
    if (isRecord(cached) && typeof cached.fetchedAt === "number") {
      const age = now - cached.fetchedAt;
      const release = parseRelease(cached.release);
      if (release && age >= 0 && age < RELEASE_CACHE_TTL_MS) return release;
    }
  } catch {
    // Corrupt entries are discarded below.
  }
  try {
    storage.removeItem(key);
  } catch {
    // Storage may be unavailable; the fetch result is still usable.
  }
  return null;
}

export async function fetchLatestRelease(
  options: {
    readonly repository?: string;
    readonly fetchImpl?: typeof fetch;
    readonly storage?: ReleaseStorage | null;
    readonly now?: () => number;
  } = {},
): Promise<Release> {
  const repository = options.repository ?? RELEASE_REPOSITORY;
  const fetchImpl = options.fetchImpl ?? fetch;
  const storage =
    options.storage === undefined
      ? typeof sessionStorage === "undefined"
        ? null
        : sessionStorage
      : options.storage;
  const now = options.now ?? Date.now;
  const cacheKey = `${CACHE_KEY_PREFIX}${repository}`;

  const cached = storage ? readCachedRelease(storage, cacheKey, now()) : null;
  if (cached) return cached;

  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`Release feed returned HTTP ${response.status}`);
  }
  const release = parseRelease(await response.json());
  if (!release) {
    throw new Error("Release feed returned an unexpected shape");
  }

  try {
    storage?.setItem(
      cacheKey,
      JSON.stringify({ fetchedAt: now(), release } satisfies CachedRelease),
    );
  } catch {
    // Quota or privacy-mode failures only cost a refetch.
  }
  return release;
}

export type DownloadPlatform = { os: "mac" | "win" | "linux"; arch?: string };

/** Matches `<name>-<version>-<suffix>` assets, e.g. `-arm64.dmg`. */
export function findAssetBySuffix(
  assets: ReadonlyArray<ReleaseAsset>,
  suffix: string,
): ReleaseAsset | undefined {
  return assets.find((asset) => asset.name.endsWith(`-${suffix}`));
}

export function pickPlatformAsset(
  assets: ReadonlyArray<ReleaseAsset>,
  platform: DownloadPlatform,
): string | null {
  if (platform.os === "win") {
    return findAssetBySuffix(assets, "x64.exe")?.browser_download_url ?? null;
  }
  if (platform.os === "mac") {
    const preferred = platform.arch ? findAssetBySuffix(assets, `${platform.arch}.dmg`) : undefined;
    const fallback = assets.find((asset) => asset.name.endsWith(".dmg"));
    return (preferred ?? fallback)?.browser_download_url ?? null;
  }
  return assets.find((asset) => asset.name.endsWith(".AppImage"))?.browser_download_url ?? null;
}
