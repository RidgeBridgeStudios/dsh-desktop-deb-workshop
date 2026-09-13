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

function compareDebianParts(s1, s2) {
  let i = 0;
  let j = 0;
  function order(c) {
    if (c === '~') return -1;
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) return c.charCodeAt(0);
    if (c === '') return 0;
    return c.charCodeAt(0) + 256;
  }
  while (i < s1.length || j < s2.length) {
    let diff = 0;
    while ((i < s1.length && !/\d/.test(s1[i])) || (j < s2.length && !/\d/.test(s2[j]))) {
      const c1 = i < s1.length ? s1[i] : '';
      const c2 = j < s2.length ? s2[j] : '';
      if (c1 !== c2) {
        diff = order(c1) - order(c2);
        break;
      }
      i++;
      j++;
    }
    if (diff !== 0) return diff;
    while (i < s1.length && !/\d/.test(s1[i])) i++;
    while (j < s2.length && !/\d/.test(s2[j])) j++;

    let num1 = 0;
    let num2 = 0;
    const startI = i;
    while (i < s1.length && /\d/.test(s1[i])) {
      num1 = num1 * 10 + Number(s1[i]);
      i++;
    }
    const startJ = j;
    while (j < s2.length && /\d/.test(s2[j])) {
      num2 = num2 * 10 + Number(s2[j]);
      j++;
    }
    if (startI < i || startJ < j) {
      if (num1 !== num2) return num1 - num2;
    }
  }
  return 0;
}

function parseDebianVersion(v) {
  const str = String(v ?? '');
  let epoch = 0;
  let rest = str;
  const colonIdx = str.indexOf(':');
  if (colonIdx !== -1 && /^\d+$/.test(str.slice(0, colonIdx))) {
    epoch = parseInt(str.slice(0, colonIdx), 10);
    rest = str.slice(colonIdx + 1);
  }
  const dashIdx = rest.lastIndexOf('-');
  let upstream = rest;
  let revision = '';
  if (dashIdx !== -1) {
    upstream = rest.slice(0, dashIdx);
    revision = rest.slice(dashIdx + 1);
  }
  return { epoch, upstream, revision };
}

export function compareDebianLt(v1, v2, customExec) {
  if (typeof customExec === 'function') {
    return customExec(v1, v2);
  }
  const p1 = parseDebianVersion(v1);
  const p2 = parseDebianVersion(v2);
  if (p1.epoch !== p2.epoch) return p1.epoch < p2.epoch;
  const upDiff = compareDebianParts(p1.upstream, p2.upstream);
  if (upDiff !== 0) return upDiff < 0;
  return compareDebianParts(p1.revision, p2.revision) < 0;
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
