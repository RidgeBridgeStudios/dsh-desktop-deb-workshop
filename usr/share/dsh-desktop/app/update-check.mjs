import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

export const DEFAULT_REPO_URL =
  'https://apt.ridgebridge.io/dists/stable/main';

export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let updateCache = {
  timestamp: 0,
  result: null
};

let latestAvailableUpdate = null;

export function clearUpdateCache() {
  updateCache = { timestamp: 0, result: null };
  latestAvailableUpdate = null;
}

export function getAvailableUpdate() {
  return latestAvailableUpdate;
}

export function setAvailableUpdate(update) {
  latestAvailableUpdate = update;
}

export function formatUpdateLabel(version) {
  const clean = String(version || '').trim();
  const display = clean.startsWith('v') ? clean : `v${clean}`;
  return `Update available: ${display}`;
}

export function compareDebianLt(v1, v2, customExec) {
  if (typeof customExec === 'function') {
    return customExec(v1, v2);
  }
  const res = spawnSync('dpkg', ['--compare-versions', String(v1), 'lt', String(v2)], {
    stdio: 'ignore'
  });
  return res.status === 0;
}

export function parseDshVersionFromPackages(packagesContent, compareFn = compareDebianLt) {
  if (typeof packagesContent !== 'string') return null;
  const blocks = packagesContent.split(/\r?\n\r?\n/);
  let latestVersion = null;

  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);
    let isDsh = false;
    let version = null;

    for (const line of lines) {
      const match = line.match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
      if (!match) continue;
      const key = match[1].toLowerCase();
      const val = match[2].trim();
      if (key === 'package' && val.toLowerCase() === 'dsh-desktop') {
        isDsh = true;
      } else if (key === 'version') {
        version = val;
      }
    }

    if (isDsh && version) {
      if (!latestVersion || compareFn(latestVersion, version)) {
        latestVersion = version;
      }
    }
  }

  return latestVersion;
}

export async function checkForUpdates(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : (options.now ?? Date.now());
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;

  if (!options.force && updateCache.result && (now - updateCache.timestamp < ttl)) {
    return updateCache.result;
  }

  const fetchFn = options.fetch || globalThis.fetch;
  const currentVersion = options.currentVersion || '1.0.0';
  const arch = options.arch || (process.arch === 'arm64' ? 'arm64' : 'amd64');
  const endpoint = options.endpoint || `${DEFAULT_REPO_URL}/binary-${arch}/Packages.gz`;
  const compareFn = options.compareFn || ((v1, v2) => compareDebianLt(v1, v2, options.exec));

  if (typeof fetchFn !== 'function') {
    return { available: false, error: 'fetch is not available' };
  }

  try {
    const res = await fetchFn(endpoint, {
      headers: {
        'User-Agent': `dsh-desktop/${currentVersion}`
      }
    });

    if (!res || !res.ok) {
      return {
        available: false,
        error: `HTTP ${res?.status || 'unknown'}`
      };
    }

    let buf;
    if (typeof res.arrayBuffer === 'function') {
      buf = Buffer.from(await res.arrayBuffer());
    } else if (typeof res.text === 'function') {
      buf = Buffer.from(await res.text(), 'utf-8');
    } else {
      return { available: false, error: 'Response body is not readable' };
    }

    let text;
    if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      try {
        text = gunzipSync(buf).toString('utf-8');
      } catch (err) {
        return { available: false, error: `Malformed gzip: ${err.message}` };
      }
    } else {
      text = buf.toString('utf-8');
    }

    const candidateVersion = parseDshVersionFromPackages(text, compareFn);
    if (!candidateVersion) {
      return { available: false, error: 'No dsh-desktop package version found in Packages' };
    }

    const isNewer = compareFn(currentVersion, candidateVersion);
    const result = {
      available: isNewer,
      version: candidateVersion
    };

    updateCache = {
      timestamp: now,
      result
    };
    latestAvailableUpdate = result;

    return result;
  } catch (err) {
    return {
      available: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}
