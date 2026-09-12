import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkForUpdates,
  formatUpdateLabel,
  getAvailableUpdate,
  setAvailableUpdate,
  DEFAULT_LATEST_RELEASE_URL
} from '../usr/share/dsh-desktop/app/update-check.mjs';
import {
  VERSION,
  buildAppMenuTemplate,
  buildTrayMenuTemplate
} from '../usr/share/dsh-desktop/app/main.js';

test('VERSION constant is exported from main.js', () => {
  assert.equal(typeof VERSION, 'string');
  assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('formatUpdateLabel formats tag with v prefix', () => {
  assert.equal(formatUpdateLabel('v1.2.0'), 'Update available: v1.2.0');
  assert.equal(formatUpdateLabel('1.2.0'), 'Update available: v1.2.0');
});

test('checkForUpdates: newer release available', async () => {
  const mockRelease = {
    tag_name: 'v1.2.0',
    html_url: 'https://github.com/RidgeBridgeStudios/dsh-desktop-deb-workshop/releases/tag/v1.2.0'
  };

  const mockFetch = async (url, init) => {
    assert.equal(url, DEFAULT_LATEST_RELEASE_URL);
    assert.equal(init?.headers?.Accept, 'application/vnd.github+json');
    return {
      ok: true,
      status: 200,
      json: async () => mockRelease
    };
  };

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0'
  });

  assert.equal(result.hasUpdate, true);
  assert.equal(result.tag, 'v1.2.0');
  assert.equal(result.version, '1.2.0');
  assert.equal(result.url, 'https://github.com/RidgeBridgeStudios/dsh-desktop-deb-workshop/releases/tag/v1.2.0');
});

test('checkForUpdates: same version', async () => {
  const mockRelease = {
    tag_name: 'v1.0.0',
    html_url: 'https://github.com/RidgeBridgeStudios/dsh-desktop-deb-workshop/releases/tag/v1.0.0'
  };

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => mockRelease
  });

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0'
  });

  assert.equal(result.hasUpdate, false);
  assert.equal(result.tag, 'v1.0.0');
  assert.equal(result.version, '1.0.0');
});

test('checkForUpdates: older release', async () => {
  const mockRelease = {
    tag_name: 'v0.9.0',
    html_url: 'https://github.com/RidgeBridgeStudios/dsh-desktop-deb-workshop/releases/tag/v0.9.0'
  };

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => mockRelease
  });

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0'
  });

  assert.equal(result.hasUpdate, false);
  assert.equal(result.tag, 'v0.9.0');
  assert.equal(result.version, '0.9.0');
});

test('checkForUpdates: handles tag without leading v', async () => {
  const mockRelease = {
    tag_name: '2.0.0',
    html_url: 'https://github.com/RidgeBridgeStudios/dsh-desktop-deb-workshop/releases/tag/v2.0.0'
  };

  const mockFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => mockRelease
  });

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0'
  });

  assert.equal(result.hasUpdate, true);
  assert.equal(result.tag, 'v2.0.0');
  assert.equal(result.version, '2.0.0');
});

test('checkForUpdates: network failure (thrown exception)', async () => {
  const mockFetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND api.github.com');
  };

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0'
  });

  assert.equal(result.hasUpdate, false);
  assert.match(result.error, /ENOTFOUND/);
});

test('checkForUpdates: HTTP error response', async () => {
  const mockFetch = async () => ({
    ok: false,
    status: 503,
    json: async () => ({})
  });

  const result = await checkForUpdates({
    fetch: mockFetch,
    currentVersion: '1.0.0'
  });

  assert.equal(result.hasUpdate, false);
  assert.equal(result.error, 'HTTP 503');
});

test('menu: shows update item when newer release exists, opens in system browser', async () => {
  const openedUrls = [];
  const mockShell = {
    openExternal: async (url) => {
      openedUrls.push(url);
    }
  };

  const updateInfo = {
    tag: 'v1.5.0',
    url: 'https://github.com/RidgeBridgeStudios/dsh-desktop-deb-workshop/releases/tag/v1.5.0'
  };

  // App menu when update is available
  const appMenuWithUpdate = buildAppMenuTemplate({
    availableUpdate: updateInfo,
    shell: mockShell
  });

  // Check top-level update menu item
  const topLevelUpdateItem = appMenuWithUpdate.find(
    (item) => item.label === 'Update available: v1.5.0'
  );
  assert.ok(topLevelUpdateItem, 'Top-level app menu should contain update item');
  await topLevelUpdateItem.click();
  assert.equal(openedUrls[0], updateInfo.url);

  // Check Help submenu update item
  const helpMenu = appMenuWithUpdate.find(
    (item) => item.label === 'Help' || item.label === '帮助'
  );
  assert.ok(helpMenu, 'Help menu should exist');
  const helpUpdateItem = helpMenu.submenu.find(
    (item) => item.label === 'Update available: v1.5.0'
  );
  assert.ok(helpUpdateItem, 'Help submenu should contain update item');
  await helpUpdateItem.click();
  assert.equal(openedUrls[1], updateInfo.url);

  // Tray menu when update is available
  const trayMenuWithUpdate = buildTrayMenuTemplate({
    availableUpdate: updateInfo,
    shell: mockShell
  });
  const trayUpdateItem = trayMenuWithUpdate.find(
    (item) => item.label === 'Update available: v1.5.0'
  );
  assert.ok(trayUpdateItem, 'Tray menu should contain update item');
  await trayUpdateItem.click();
  assert.equal(openedUrls[2], updateInfo.url);

  // When no update is available
  const appMenuNoUpdate = buildAppMenuTemplate({
    availableUpdate: null
  });
  assert.equal(
    appMenuNoUpdate.some((item) => item.label?.startsWith('Update available:')),
    false
  );
  const helpMenuNoUpdate = appMenuNoUpdate.find(
    (item) => item.label === 'Help' || item.label === '帮助'
  );
  assert.equal(
    helpMenuNoUpdate.submenu.some((item) => item.label?.startsWith('Update available:')),
    false
  );
});
