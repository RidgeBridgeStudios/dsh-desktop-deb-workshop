import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  resolveImportPresetPath,
  registerIpcHandlers
} from '../usr/share/dsh-desktop/app/main.js'
import { registerPreloadBridges } from '../usr/share/dsh-desktop/app/preload.cjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

test('MIME XML: dsh-desktop.xml conforms to freedesktop specification', async () => {
  const mimePath = path.join(rootDir, 'usr/share/mime/packages/dsh-desktop.xml')
  assert.ok(existsSync(mimePath), 'usr/share/mime/packages/dsh-desktop.xml must exist')
  const content = await readFile(mimePath, 'utf8')

  assert.match(content, /<mime-type type="application\/x-dshpreset">/u)
  assert.match(content, /<glob pattern="\*\.dshpreset"\/>/u)
  assert.match(content, /<sub-class-of type="application\/zip"\/>/u)
  assert.match(content, /<comment>/u)
})

test('Desktop entry: dsh-desktop-preset.desktop configures application and file association', async () => {
  const desktopPath = path.join(rootDir, 'usr/share/applications/dsh-desktop-preset.desktop')
  assert.ok(existsSync(desktopPath), 'usr/share/applications/dsh-desktop-preset.desktop must exist')
  const content = await readFile(desktopPath, 'utf8')

  assert.match(content, /^\[Desktop Entry\]/m)
  assert.match(content, /^Exec=\/usr\/bin\/dsh-desktop --import-preset=%f/m)
  assert.match(content, /^MimeType=application\/x-dshpreset;/m)
  assert.match(content, /^Terminal=false/m)
  assert.match(content, /^Type=Application/m)
  assert.match(content, /^NoDisplay=false/m)
})

test('resolveImportPresetPath: parses --import-preset flag from CLI arguments', () => {
  assert.equal(
    resolveImportPresetPath(['node', 'main.js', '--import-preset=/tmp/preset.dshpreset']),
    '/tmp/preset.dshpreset'
  )
  assert.equal(
    resolveImportPresetPath(['node', 'main.js', '--other', '--import-preset', '/tmp/another.dshpreset']),
    '/tmp/another.dshpreset'
  )
  assert.equal(
    resolveImportPresetPath(['node', 'main.js', '--ozone-platform-hint=auto']),
    null
  )
})

test('preload bridge: exposes preset import functions on dshDesktop', async () => {
  const exposed = {}
  const mockBridge = {
    exposeInMainWorld(key, api) {
      exposed[key] = api
    }
  }
  const calls = []
  const mockIpc = {
    invoke(channel, ...args) {
      calls.push({ channel, args })
      return Promise.resolve({ ok: true, channel, args })
    }
  }

  registerPreloadBridges(mockBridge, mockIpc)

  assert.ok(typeof exposed.dshDesktop.getImportPresetPath === 'function')
  assert.ok(typeof exposed.dshDesktop.getImportPresetData === 'function')
  assert.ok(typeof exposed.dshDesktop.showImportPresetMessage === 'function')

  await exposed.dshDesktop.getImportPresetPath()
  assert.equal(calls[calls.length - 1].channel, 'preset:get-import-path')

  await exposed.dshDesktop.getImportPresetData('/tmp/preset.dshpreset')
  assert.equal(calls[calls.length - 1].channel, 'preset:get-import-data')
  assert.deepEqual(calls[calls.length - 1].args, ['/tmp/preset.dshpreset'])

  await exposed.dshDesktop.showImportPresetMessage('test message')
  assert.equal(calls[calls.length - 1].channel, 'preset:show-message')
  assert.deepEqual(calls[calls.length - 1].args, ['test message'])
})

test('preset IPC handlers: reject untrusted senders', async () => {
  const handlers = {}
  const mockIpc = {
    handle(channel, fn) {
      handlers[channel] = fn
    }
  }
  registerIpcHandlers(mockIpc, {
    importPresetPath: '/tmp/preset.dshpreset'
  })

  const untrustedEvent = { senderFrame: { url: 'https://evil.example.com' } }
  const channels = ['preset:get-import-path', 'preset:get-import-data', 'preset:show-message']

  for (const channel of channels) {
    assert.ok(typeof handlers[channel] === 'function', `Handler for ${channel} must exist`)
    await assert.rejects(
      () => handlers[channel](untrustedEvent),
      /Untrusted IPC sender/,
      `${channel} must reject untrusted sender`
    )
  }
})

test('launcher: contains argument parsing and passes forward arguments to Electron', async () => {
  const launcherPath = path.join(rootDir, 'usr/lib/dsh-desktop/bin/dsh-desktop')
  const launcher = await readFile(launcherPath, 'utf8')

  assert.match(launcher, /--import-preset/u)
  assert.match(launcher, /ELECTRON_ARGS/u)
})
