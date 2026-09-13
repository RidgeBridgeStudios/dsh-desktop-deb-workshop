import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  createSnapshot,
  pruneSnapshots,
  verifyArchiveChecksum,
  DEFAULT_RETENTION
} from '../usr/share/dsh-desktop/lib/plugin-manager/snapshot.mjs';

function createFixtureTree(baseDir) {
  const defaultProfile = path.join(baseDir, 'profiles', 'default');
  const genDesired = path.join(baseDir, 'profiles', '.generations');
  const genLive = path.join(baseDir, 'profiles', '.generations', 'live');
  const recoveryDir = path.join(baseDir, 'recovery');
  const sessionsDir = path.join(baseDir, 'sessions');
  const launchRootDir = path.join(baseDir, 'launch-root');
  const nodeModulesDir = path.join(defaultProfile, 'node_modules', 'some-pkg');

  fs.mkdirSync(defaultProfile, { recursive: true });
  fs.mkdirSync(genDesired, { recursive: true });
  fs.mkdirSync(genLive, { recursive: true });
  fs.mkdirSync(recoveryDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(launchRootDir, { recursive: true });
  fs.mkdirSync(nodeModulesDir, { recursive: true });

  fs.writeFileSync(path.join(defaultProfile, 'package.json'), JSON.stringify({ name: 'default-profile' }));
  fs.writeFileSync(path.join(defaultProfile, 'pnpm-lock.yaml'), 'lockfile-content: true\n');
  fs.writeFileSync(path.join(defaultProfile, 'cordis.patch.yml'), 'patch: true\n');
  fs.writeFileSync(path.join(defaultProfile, 'pnpm-workspace.yaml'), 'packages: ["."]\n');
  fs.writeFileSync(path.join(genDesired, 'desired.json'), JSON.stringify(['pkg-a']));
  fs.writeFileSync(path.join(genLive, 'live-file.txt'), 'should be excluded');
  fs.writeFileSync(path.join(recoveryDir, 'plugin-removals.json'), JSON.stringify({ removals: [] }));
  fs.writeFileSync(path.join(baseDir, 'settings.yaml'), 'theme: dark\n');
  fs.writeFileSync(path.join(sessionsDir, 'session-1.json'), JSON.stringify({ id: 1 }));
  fs.writeFileSync(path.join(launchRootDir, 'tmp.txt'), 'should be excluded');
  fs.writeFileSync(path.join(nodeModulesDir, 'index.js'), 'should be excluded');
}

test('createSnapshot: creates and verifies archive with sha256', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-snapshot-test-'));
  try {
    createFixtureTree(tmp);
    const res = await createSnapshot({
      dshHome: tmp,
      reason: 'pre-update',
      clock: () => 1700000000000
    });

    assert.ok(fs.existsSync(res.archivePath), 'Archive file must exist');
    assert.ok(fs.existsSync(res.shaPath), 'SHA file must exist');
    assert.ok(res.archivePath.endsWith('.tar.zst') || res.archivePath.endsWith('.tar.gz'));

    // Verify SHA-256 verification succeeds
    assert.equal(verifyArchiveChecksum(res.archivePath), true);

    // List tar contents to verify inclusion
    const tarOutput = execFileSync('tar', ['-tf', res.archivePath], { encoding: 'utf8' });
    assert.match(tarOutput, /profiles\/default\/package\.json/);
    assert.match(tarOutput, /sessions\/session-1\.json/);
    assert.match(tarOutput, /settings\.yaml/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createSnapshot: honors exclusions (node_modules, live, launch-root, backups)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-snapshot-test-'));
  try {
    createFixtureTree(tmp);
    const res = await createSnapshot({
      dshHome: tmp,
      reason: 'pre-plugin-mutation'
    });

    const tarOutput = execFileSync('tar', ['-tf', res.archivePath], { encoding: 'utf8' });
    assert.doesNotMatch(tarOutput, /profiles\/default\/node_modules/);
    assert.doesNotMatch(tarOutput, /profiles\/\.generations\/live/);
    assert.doesNotMatch(tarOutput, /launch-root/);
    assert.doesNotMatch(tarOutput, /backups/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createSnapshot: enforces retention and purges oldest first', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-snapshot-test-'));
  try {
    createFixtureTree(tmp);

    // Create 4 snapshots for pre-plugin-mutation with keep: 2
    for (let i = 1; i <= 4; i++) {
      await createSnapshot({
        dshHome: tmp,
        reason: 'pre-plugin-mutation',
        keep: 2,
        clock: () => 1700000000000 + i * 1000,
        timestamp: `ts-00${i}`
      });
      // Small sleep so mtimes advance if mtime fallback is used
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const backupsDir = path.join(tmp, 'backups');
    const files = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.tar.zst') || f.endsWith('.tar.gz'));
    assert.equal(files.length, 2, 'Only 2 archives should be retained');

    // ts-003 and ts-004 should be kept; ts-001 and ts-002 should be purged
    assert.ok(files.some((f) => f.includes('ts-003')));
    assert.ok(files.some((f) => f.includes('ts-004')));
    assert.ok(!files.some((f) => f.includes('ts-001')));
    assert.ok(!files.some((f) => f.includes('ts-002')));

    // Corresponding sha256 files should also be 2
    const shaFiles = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.sha256'));
    assert.equal(shaFiles.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createSnapshot: fails closed on missing source files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-snapshot-test-'));
  try {
    // Empty directory: package.json missing
    await assert.rejects(
      () => createSnapshot({ dshHome: tmp, reason: 'pre-update' }),
      /Missing required source file/
    );

    // Nonexistent dshHome
    await assert.rejects(
      () => createSnapshot({ dshHome: path.join(tmp, 'nonexistent'), reason: 'pre-update' }),
      /directory does not exist/
    );

    // Backups directory should remain empty
    const backupsDir = path.join(tmp, 'backups');
    if (fs.existsSync(backupsDir)) {
      assert.equal(fs.readdirSync(backupsDir).length, 0);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createSnapshot: falls back to gzip when useZstd is false', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-snapshot-test-'));
  try {
    createFixtureTree(tmp);
    const res = await createSnapshot({
      dshHome: tmp,
      reason: 'daily',
      useZstd: false
    });

    assert.equal(res.format, 'gzip');
    assert.ok(res.archivePath.endsWith('.tar.gz'));
    assert.ok(fs.existsSync(res.archivePath));
    assert.equal(verifyArchiveChecksum(res.archivePath), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createSnapshot: sanitizes reason in archive basename', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-snapshot-test-'));
  try {
    createFixtureTree(tmp);
    const res = await createSnapshot({
      dshHome: tmp,
      reason: '../../etc/passwd',
      clock: () => 1700000000000
    });

    const base = path.basename(res.archivePath);
    assert.equal(base.includes('..'), false, 'basename must not contain ..');
    assert.equal(base.includes('/'), false, 'basename must not contain /');
    assert.equal(res.reason, '../../etc/passwd', 'original reason is preserved');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
