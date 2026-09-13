import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { dshHome as defaultDshHome } from './paths.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_RETENTION = Object.freeze({
  'pre-update': 5,
  'pre-plugin-mutation': 3,
  'daily': 1,
  'pre-profile-delete': 1,
  'pre-profile-restore': 3
});

export const FILE_SET_CANDIDATES = Object.freeze([
  'profiles/default/package.json',
  'pnpm-lock.yaml',
  'profiles/default/pnpm-lock.yaml',
  'cordis.patch.yml',
  'profiles/default/cordis.patch.yml',
  'pnpm-workspace.yaml',
  'profiles/default/pnpm-workspace.yaml',
  'profiles/.generations/desired.json',
  'recovery/plugin-removals.json',
  'settings.yaml',
  'sessions'
]);

export const DEFAULT_EXCLUSIONS = Object.freeze([
  'profiles/default/node_modules',
  'profiles/default/node_modules/*',
  'profiles/.generations/live',
  'profiles/.generations/live/*',
  'launch-root',
  'launch-root/*',
  'backups',
  'backups/*'
]);

export function hasBinary(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function computeSha256(filePath) {
  const content = fs.readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export function verifyArchiveChecksum(archivePath) {
  const shaPath = `${archivePath}.sha256`;
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archive file not found: ${archivePath}`);
  }
  if (!fs.existsSync(shaPath)) {
    throw new Error(`Checksum file not found: ${shaPath}`);
  }
  const rawSha = fs.readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0];
  const actualSha = computeSha256(archivePath);
  if (rawSha !== actualSha) {
    throw new Error(`SHA-256 mismatch for ${archivePath}: expected ${rawSha}, got ${actualSha}`);
  }
  return true;
}

export async function pruneSnapshots(options = {}) {
  const home = options.dshHome || defaultDshHome();
  const reason = options.reason;
  const profile = options.profile;
  const backupsDir = path.join(home, 'backups');
  if (!fs.existsSync(backupsDir)) return [];

  const defaultKeep = reason && DEFAULT_RETENTION[reason] !== undefined
    ? DEFAULT_RETENTION[reason]
    : 3;
  const keep = typeof options.keep === 'number' && options.keep >= 0
    ? options.keep
    : defaultKeep;

  const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const entries = fs.readdirSync(backupsDir, { withFileTypes: true });
  let regex
  if (profile) {
    const safeProfile = String(profile).replace(/\.\./g, '_').replace(/[^a-z0-9._-]/gi, '_').slice(0, 64);
    regex = reason
      ? new RegExp(`^.*-${escapeRegex(reason)}-${escapeRegex(safeProfile)}\\.tar\\.(zst|gz)$`)
      : new RegExp(`^.*-${escapeRegex(safeProfile)}\\.tar\\.(zst|gz)$`);
  } else {
    regex = reason
      ? new RegExp(`^.*-${escapeRegex(reason)}\\.tar\\.(zst|gz)$`)
      : /^.*\\.tar\\.(zst|gz)$/;
  }

  const archives = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (regex.test(entry.name)) {
      const fullPath = path.join(backupsDir, entry.name);
      const stat = fs.statSync(fullPath);
      archives.push({
        name: entry.name,
        path: fullPath,
        mtimeMs: stat.mtimeMs
      });
    }
  }

  // Sort descending by timestamp / mtimeMs (newest first)
  archives.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  const pruned = [];
  if (archives.length > keep) {
    const toRemove = archives.slice(keep);
    for (const item of toRemove) {
      try {
        fs.unlinkSync(item.path);
        pruned.push(item.path);
      } catch {}
      const shaFile = `${item.path}.sha256`;
      if (fs.existsSync(shaFile)) {
        try {
          fs.unlinkSync(shaFile);
        } catch {}
      }
    }
  }
  return pruned;
}

export async function createSnapshot(options = {}) {
  const home = options.dshHome || defaultDshHome();
  const reason = options.reason || 'manual';
  const profile = options.profile;
  const clock = options.clock || (() => Date.now());

  if (!home || !fs.existsSync(home)) {
    throw new Error(`dshHome directory does not exist: ${home}`);
  }

  const defaultReq = profile ? [`profiles/${profile}/package.json`] : ['profiles/default/package.json'];
  const requiredFiles = options.requiredFiles || defaultReq;
  for (const req of requiredFiles) {
    const full = path.join(home, req);
    if (!fs.existsSync(full)) {
      throw new Error(`Missing required source file: ${req}`);
    }
  }

  const candidates = profile
    ? [
        `profiles/${profile}`,
        `profiles/.generations/desired/${profile}.json`,
        `recovery/plugin-removals/${profile}.json`
      ]
    : FILE_SET_CANDIDATES;

  // Collect existing files/directories from candidate set
  const present = [];
  for (const candidate of candidates) {
    const candidatePath = path.join(home, candidate);
    if (fs.existsSync(candidatePath)) {
      present.push(candidate);
    }
  }

  if (present.length === 0) {
    throw new Error('No source files found in dshHome to snapshot');
  }

  const backupsDir = path.join(home, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });

  const useZstd = options.useZstd ?? hasBinary('zstd');
  const ext = useZstd ? '.tar.zst' : '.tar.gz';
  const filterFlag = useZstd ? '--zstd' : '--gzip';

  const ts = options.timestamp || new Date(clock()).toISOString().replace(/[:.]/g, '-');
  const safeReason = String(reason).replace(/\.\./g, '_').replace(/[^a-z0-9._-]/gi, '_').slice(0, 64);
  const safeProfile = profile ? String(profile).replace(/\.\./g, '_').replace(/[^a-z0-9._-]/gi, '_').slice(0, 64) : null;
  const archiveName = safeProfile
    ? `${ts}-${safeReason}-${safeProfile}${ext}`
    : `${ts}-${safeReason}${ext}`;
  const archivePath = path.join(backupsDir, archiveName);
  const shaPath = `${archivePath}.sha256`;

  const tarArgs = [
    '-C',
    home,
    filterFlag,
    '-cf',
    archivePath
  ];

  const defaultExcl = profile
    ? [...DEFAULT_EXCLUSIONS, `profiles/${profile}/node_modules`, `profiles/${profile}/node_modules/*`]
    : DEFAULT_EXCLUSIONS;
  const exclusions = options.exclusions || defaultExcl;
  for (const exc of exclusions) {
    tarArgs.push(`--exclude=${exc}`);
  }

  for (const rel of present) {
    tarArgs.push(rel);
  }

  try {
    await execFileAsync('tar', tarArgs);
  } catch (err) {
    if (fs.existsSync(archivePath)) {
      try { fs.unlinkSync(archivePath); } catch {}
    }
    throw new Error(`Failed to create snapshot tar archive: ${err.message}`);
  }

  try {
    const hash = computeSha256(archivePath);
    const shaContent = `${hash}  ${path.basename(archivePath)}\n`;
    fs.writeFileSync(shaPath, shaContent, 'utf8');

    // Verify after write
    verifyArchiveChecksum(archivePath);
  } catch (err) {
    if (fs.existsSync(archivePath)) {
      try { fs.unlinkSync(archivePath); } catch {}
    }
    if (fs.existsSync(shaPath)) {
      try { fs.unlinkSync(shaPath); } catch {}
    }
    throw err;
  }

  // Retention enforcement
  await pruneSnapshots({
    dshHome: home,
    reason,
    profile,
    keep: options.keep
  });

  return {
    archivePath,
    shaPath,
    format: useZstd ? 'zstd' : 'gzip',
    reason
  };
}

export async function listSnapshots(dshHome = defaultDshHome(), options = {}) {
  const profile = options.profile;
  const snapDir = snapshotsDirectory(dshHome);
  if (!fs.existsSync(snapDir)) return [];
  const entries = await fs.promises.readdir(snapDir);
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.endsWith('.tar.gz') && !entry.endsWith('.tar.zst')) continue;
    if (profile) {
      const match = entry.match(/^\d+-[a-z0-9._-]+-(.+)\.tar\.(?:gz|zst)$/);
      if (match && match[1] === profile) {
        snapshots.push({
          name: entry,
          path: path.join(snapDir, entry),
          profile
        });
      }
    } else {
      snapshots.push({
        name: entry,
        path: path.join(snapDir, entry)
      });
    }
  }
  snapshots.sort((a, b) => b.name.localeCompare(a.name));
  return snapshots;
}

export async function restoreSnapshot(archivePath, dshHome = defaultDshHome(), options = {}) {
  const profile = options.profile;
  if (!archivePath || !fs.existsSync(archivePath)) {
    throw new Error(`Snapshot archive not found: ${archivePath}`);
  }
  verifyArchiveChecksum(archivePath);

  if (profile) {
    await createSnapshot({
      dshHome,
      reason: 'pre-profile-restore',
      profile
    });
  }

  const useZstd = archivePath.endsWith('.tar.zst');
  const tarArgs = ['-xf', archivePath, '-C', dshHome];
  if (useZstd) {
    tarArgs.unshift('--zstd');
  }

  await execFileAsync('tar', tarArgs);
  return { ok: true, archivePath };
}

