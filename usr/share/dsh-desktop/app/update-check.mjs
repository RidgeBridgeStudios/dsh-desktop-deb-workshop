import { compareSemver, parseSemver } from '../lib/plugin-manager/compatibility.mjs';

export const DEFAULT_LATEST_RELEASE_URL =
  'https://api.github.com/repos/RidgeBridgeStudios/dsh-desktop-deb-workshop/releases/latest';

export const RELEASES_PAGE_URL =
  'https://github.com/RidgeBridgeStudios/dsh-desktop-deb-workshop/releases';

let latestAvailableUpdate = null;

export function getAvailableUpdate() {
  return latestAvailableUpdate;
}

export function setAvailableUpdate(update) {
  latestAvailableUpdate = update;
}

export function formatUpdateLabel(tag) {
  const displayTag = String(tag || '').startsWith('v') ? tag : `v${tag}`;
  return `Update available: ${displayTag}`;
}

export async function checkForUpdates(options = {}) {
  const fetchFn = options.fetch || globalThis.fetch;
  const endpoint = options.endpoint || DEFAULT_LATEST_RELEASE_URL;
  const currentVersion = options.currentVersion || '1.0.0';

  if (typeof fetchFn !== 'function') {
    return { hasUpdate: false, error: 'fetch is not available' };
  }

  try {
    const res = await fetchFn(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `dsh-desktop/${currentVersion}`
      }
    });

    if (!res || !res.ok) {
      return {
        hasUpdate: false,
        error: `HTTP ${res?.status || 'unknown'}`
      };
    }

    const data = await res.json();
    const rawTag = data?.tag_name;
    if (!rawTag || typeof rawTag !== 'string') {
      return { hasUpdate: false, error: 'Invalid release payload: missing tag_name' };
    }

    const cleanTag = rawTag.trim();
    const semverString = cleanTag.startsWith('v') ? cleanTag.slice(1) : cleanTag;
    const displayTag = cleanTag.startsWith('v') ? cleanTag : `v${cleanTag}`;

    const parsed = parseSemver(semverString);
    if (!parsed) {
      return { hasUpdate: false, error: `Invalid semver tag: ${rawTag}` };
    }

    const isNewer = compareSemver(semverString, currentVersion) > 0;
    const releaseUrl = data?.html_url || (cleanTag ? `${RELEASES_PAGE_URL}/tag/${cleanTag}` : DEFAULT_LATEST_RELEASE_URL);

    return {
      hasUpdate: isNewer,
      tag: displayTag,
      version: semverString,
      url: releaseUrl
    };
  } catch (err) {
    return {
      hasUpdate: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
