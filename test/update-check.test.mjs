import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import {
  checkForUpdates,
  formatUpdateLabel,
  getAvailableUpdate,
  setAvailableUpdate,
  clearUpdateCache,
  parseDshVersionFromPackages,
  compareDebianLt
} from '../usr/share/dsh-desktop/app/update-check.mjs';

import {
  VERSION,
  buildAppMenuTemplate,
  buildTrayMenuTemplate,
  runUpgradeHelper,
  registerIpcHandlers
} from '../usr/share/dsh-desktop/app/main.js';

function makePackagesContent(version, pkg = 'dsh-desktop') {
  return [
    'Package: ' + pkg,
    'Version: ' + version,
    'Architecture: amd64',
    'Maintainer: RidgeBridgeStudios',
    'Description: Sandboxed desktop workspace'
  ].join('\n') + '\n\n';
}

function makeGzResponse(text, status = 200) {
  const gz = gzipSync(Buffer.from(text, 'utf-8'));
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength),
    text: async () => text
  };
}

test('VERSION constant is exported from main.js', () => {
  assert.equal(typeof VERSION, 'string');
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('formatUpdateLabel formats version with v prefix', () => {
  assert.equal(formatUpdateLabel('1.2.0'), 'Update available: v1.2.0');
  assert.equal(formatUpdateLabel('v1.2.0'), 'Update available: v1.2.0');
});

test('compareDebianLt compares versions correctly', () => {
  assert.equal(compareDebianLt('1.0.0', '1.1.0'), true);
  assert.equal(compareDebianLt('1.1.0', '1.0.0'), false);
  assert.equal(compareDebianLt('1.0.0', '1.0.0'), false);
  assert.equal(compareDebianLt('1.0.0-1', '1.0.0-2'), true);
});

test('parseDshVersionFromPackages extracts dsh-desktop version', () => {
  const content = makePackagesContent('1.5.0') + makePackagesContent('2.0.0', 'other-package');
  const ver = parseDshVersionFromPackages(content);
  assert.equal(ver, '1.5.0');
});

test('checkForUpdates: newer release available in mocked Packages.gz', async () => {
  clearUpdateCache();
  const mockFetch = async () => makeGzResponse(makePackagesContent('1.2.0'));

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0',
    force: true
  });

  assert.equal(result.available, true);
  assert.equal(result.version, '1.2.0');
});

test('checkForUpdates: same version in mocked Packages', async () => {
  clearUpdateCache();
  const mockFetch = async () => makeGzResponse(makePackagesContent('1.0.0'));

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0',
    force: true
  });

  assert.equal(result.available, false);
  assert.equal(result.version, '1.0.0');
});

test('checkForUpdates: older release in mocked Packages', async () => {
  clearUpdateCache();
  const mockFetch = async () => makeGzResponse(makePackagesContent('0.9.0'));

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0',
    force: true
  });

  assert.equal(result.available, false);
  assert.equal(result.version, '0.9.0');
});

test('checkForUpdates: network failure (fetch throws)', async () => {
  clearUpdateCache();
  const mockFetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND apt.ridgebridge.io');
  };

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0',
    force: true
  });

  assert.equal(result.available, false);
  assert.match(result.error, /ENOTFOUND/);
});

test('checkForUpdates: HTTP error response', async () => {
  clearUpdateCache();
  const mockFetch = async () => ({
    ok: false,
    status: 404,
    arrayBuffer: async () => Buffer.from(''),
    text: async () => ''
  });

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0',
    force: true
  });

  assert.equal(result.available, false);
  assert.equal(result.error, 'HTTP 404');
});

test('checkForUpdates: malformed Packages file (corrupt gzip)', async () => {
  clearUpdateCache();
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => Buffer.from([0x1f, 0x8b, 0x00, 0xff]), // invalid gzip stream
    text: async () => ''
  });

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0',
    force: true
  });

  assert.equal(result.available, false);
  assert.match(result.error, /Malformed gzip/);
});

test('checkForUpdates: malformed Packages file (missing dsh-desktop entry)', async () => {
  clearUpdateCache();
  const mockFetch = async () => makeGzResponse(makePackagesContent('2.0.0', 'unrelated-pkg'));

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0',
    force: true
  });

  assert.equal(result.available, false);
  assert.match(result.error, /No dsh-desktop package version found/);
});

test('checkForUpdates: caches result for 6 hours', async () => {
  clearUpdateCache();
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    return makeGzResponse(makePackagesContent('1.5.0'));
  };

  let simulatedTime = 1000000;
  const nowFn = () => simulatedTime;

  // First check - calls fetch
  const res1 = await checkForUpdates({ fetch: mockFetch, currentVersion: '1.0.0', now: nowFn });
  assert.equal(fetchCount, 1);
  assert.equal(res1.available, true);

  // Second check 1 hour later - hits cache
  simulatedTime += 1 * 60 * 60 * 1000;
  const res2 = await checkForUpdates({ fetch: mockFetch, currentVersion: '1.0.0', now: nowFn });
  assert.equal(fetchCount, 1);
  assert.equal(res2.available, true);

  // Third check after 6.5 hours - cache expired, fetches again
  simulatedTime += 5.5 * 60 * 60 * 1000;
  const res3 = await checkForUpdates({ fetch: mockFetch, currentVersion: '1.0.0', now: nowFn });
  assert.equal(fetchCount, 2);
  assert.equal(res3.available, true);
});

test('menu: shows update item when available and triggers pkexec upgrade helper', async () => {
  const updateInfo = {
    available: true,
    version: '1.5.0'
  };

  let helperRan = false;
  const mockUpgradeHelper = async () => {
    helperRan = true;
  };

  const appMenuWithUpdate = buildAppMenuTemplate({
    availableUpdate: updateInfo,
    runUpgradeHelper: mockUpgradeHelper
  });

  // Assert at most one item starts with 'Update available:' across entire menu structure
  function collectUpdateItems(items) {
    const found = [];
    for (const item of items) {
      if (typeof item.label === 'string' && item.label.startsWith('Update available:')) {
        found.push(item);
      }
      if (Array.isArray(item.submenu)) {
        found.push(...collectUpdateItems(item.submenu));
      }
    }
    return found;
  }
  const updateItems = collectUpdateItems(appMenuWithUpdate);
  assert.equal(updateItems.length, 1, 'App menu should contain AT MOST ONE item starting with Update available:');

  // Assert the item lives inside the Help submenu
  const helpMenu = appMenuWithUpdate.find((item) => item.label === 'Help' || item.label === '帮助');
  assert.ok(helpMenu, 'Help menu must exist');
  const helpItem = helpMenu.submenu.find((item) => item.label?.startsWith('Update available:'));
  assert.ok(helpItem, 'Update item must live inside Help submenu');
  assert.equal(helpItem.label, 'Update available: v1.5.0');
  await helpItem.click();
  assert.equal(helperRan, true);

  // Tray menu update item
  helperRan = false;
  const trayMenuWithUpdate = buildTrayMenuTemplate({
    availableUpdate: updateInfo,
    runUpgradeHelper: mockUpgradeHelper
  });
  const trayItem = trayMenuWithUpdate.find((item) => item.label === 'Update available: v1.5.0');
  assert.ok(trayItem, 'Tray menu should contain update item');
  await trayItem.click();
  assert.equal(helperRan, true);

  // When no update is available
  const appMenuNoUpdate = buildAppMenuTemplate({
    availableUpdate: { available: false, version: '1.0.0' }
  });
  assert.equal(appMenuNoUpdate.some((item) => item.label?.startsWith('Update available:')), false);
});

test('runUpgradeHelper spawns pkexec and relaunches on success', () => {
  let spawnedCmd = null;
  let spawnedArgs = null;
  let relaunched = false;
  let exitedCode = null;

  const mockApp = {
    relaunch: () => { relaunched = true; },
    exit: (code) => { exitedCode = code; }
  };

  const mockChild = {
    callbacks: {},
    on(event, cb) {
      this.callbacks[event] = cb;
    }
  };

  const mockSpawn = (cmd, args) => {
    spawnedCmd = cmd;
    spawnedArgs = args;
    return mockChild;
  };

  runUpgradeHelper({
    helperPath: '/usr/lib/dsh-desktop/bin/dsh-desktop-upgrade-helper',
    spawn: mockSpawn,
    app: mockApp
  });

  assert.equal(spawnedCmd, 'pkexec');
  assert.deepEqual(spawnedArgs, ['/usr/lib/dsh-desktop/bin/dsh-desktop-upgrade-helper']);

  // Simulate successful exit
  mockChild.callbacks['close'](0);
  assert.equal(relaunched, true);
  assert.equal(exitedCode, 0);
});

test('preload IPC update:available handler returns update status', async () => {
  const handlers = {};
  const mockIpc = {
    handle: (channel, handler) => {
      handlers[channel] = handler;
    }
  };

  registerIpcHandlers(mockIpc, {
    getAvailableUpdate: () => ({ available: true, version: '1.3.0' })
  });

  assert.ok(handlers['update:available'], 'update:available handler registered');
  const mockEvent = { senderFrame: { url: 'http://127.0.0.1:8080/loading.html' } };
  const res = await handlers['update:available'](mockEvent);
  assert.equal(res.available, true);
  assert.equal(res.version, '1.3.0');
});

test('buildAppMenuTemplate: gates toggleDevTools on DSH_DESKTOP_DEV=1', async () => {
  const { buildAppMenuTemplate } = await import('../usr/share/dsh-desktop/app/main.js');
  const origEnv = process.env.DSH_DESKTOP_DEV;
  try {
    delete process.env.DSH_DESKTOP_DEV;
    const templateNoDev = buildAppMenuTemplate();
    const viewSubmenuNoDev = templateNoDev.find((item) => item.label === 'View' || item.label === '视图')?.submenu || [];
    assert.ok(!viewSubmenuNoDev.some((item) => item.role === 'toggleDevTools'), 'toggleDevTools must not be present when DSH_DESKTOP_DEV unset');

    process.env.DSH_DESKTOP_DEV = '1';
    const templateWithDev = buildAppMenuTemplate();
    const viewSubmenuWithDev = templateWithDev.find((item) => item.label === 'View' || item.label === '视图')?.submenu || [];
    assert.ok(viewSubmenuWithDev.some((item) => item.role === 'toggleDevTools'), 'toggleDevTools must be present when DSH_DESKTOP_DEV=1');
  } finally {
    if (origEnv === undefined) {
      delete process.env.DSH_DESKTOP_DEV;
    } else {
      process.env.DSH_DESKTOP_DEV = origEnv;
    }
  }
});

