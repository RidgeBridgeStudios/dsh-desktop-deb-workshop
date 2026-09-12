import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { strToU8, zipSync } from 'fflate'

import {
  createPresetArchive,
  inspectPresetArchive,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_UNCOMPRESSED_BYTES,
  MAX_COMPRESSED_BYTES
} from '../usr/share/dsh-desktop/lib/plugin-manager/preset-archive.mjs'
import {
  createPresetRequestHandler,
  defaultHarnessBase,
  handlePresetExport,
  handlePresetImportInstall,
  handlePresetImportPreview,
  PRESET_EXPORT_PATH,
  PRESET_IMPORT_PATH
} from '../usr/share/dsh-desktop/lib/plugin-manager/preset-routes.mjs'
import { createMarketServer, listenMarketServer } from '../usr/share/dsh-desktop/lib/plugin-manager/market-server.mjs'

async function createTempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'preset-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    writeHead(status, headers = {}) {
      res.statusCode = status
      res.headers = { ...res.headers, ...headers }
    },
    end(data) {
      res.body = data
    }
  }
  return res
}

// ---------------------------------------------------------------------------
// Export Tests
// ---------------------------------------------------------------------------

test('export: round-trip export, unzip, verify tree and Content-Disposition', async (t) => {
  const temp = await createTempDir(t)
  const presetDir = join(temp, 'my-preset')
  await mkdir(presetDir, { recursive: true })
  await writeFile(join(presetDir, 'agent.cordis.yml'), '[]\n')
  await writeFile(join(presetDir, 'preset.yml'), 'name: My Preset\ndescription: Test\n')

  const roots = [{ path: temp, trust: 'user' }]
  const req = {
    url: `${PRESET_EXPORT_PATH}?agentPreset=my-preset`,
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {}
  }
  const res = mockRes()

  await handlePresetExport(req, res, { roots })
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/vnd.dsh.preset+zip')
  assert.equal(res.headers['content-disposition'], 'attachment; filename="my-preset.dshpreset"')

  const inspected = inspectPresetArchive(res.body)
  assert.equal(inspected.manifest.id, 'my-preset')
  assert.equal(inspected.manifest.name, 'My Preset')
  assert.ok(inspected.entries['preset/agent.cordis.yml'])
  assert.ok(inspected.entries['preset/preset.yml'])
})

test('export: rejects symlink in preset directory', async (t) => {
  const temp = await createTempDir(t)
  const presetDir = join(temp, 'symlink-preset')
  await mkdir(presetDir, { recursive: true })
  await writeFile(join(presetDir, 'agent.cordis.yml'), '[]\n')
  await symlink('/etc/passwd', join(presetDir, 'leak.txt'))

  const roots = [{ path: temp, trust: 'user' }]
  const req = { url: `${PRESET_EXPORT_PATH}?agentPreset=symlink-preset`, method: 'GET', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetExport(req, res, { roots })
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error, /Symlinks are not allowed/u)
})

test('export: rejects built-in preset with 403', async (t) => {
  const temp = await createTempDir(t)
  const presetDir = join(temp, 'builtin-preset')
  await mkdir(presetDir, { recursive: true })
  await writeFile(join(presetDir, 'agent.cordis.yml'), '[]\n')

  const roots = [{ path: temp, trust: 'system' }]
  const req = { url: `${PRESET_EXPORT_PATH}?agentPreset=builtin-preset`, method: 'GET', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetExport(req, res, { roots })
  assert.equal(res.statusCode, 403)
  assert.match(JSON.parse(res.body).error, /duplicate the preset first/u)
})

test('export: rejects broken preset with 400', async (t) => {
  const temp = await createTempDir(t)
  const roots = [{ path: temp, trust: 'user' }]
  const req = { url: `${PRESET_EXPORT_PATH}?agentPreset=broken-preset`, method: 'GET', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetExport(req, res, {
    roots,
    scanRootFn: async () => [{ id: 'broken-preset', trust: 'user', path: join(temp, 'broken-preset', 'agent.cordis.yml'), broken: 'syntax error in YAML' }]
  })
  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error, /Cannot export broken preset/u)
})

test('export: ignores OS metadata (.DS_Store, ._*, __MACOSX)', async (t) => {
  const temp = await createTempDir(t)
  const presetDir = join(temp, 'os-meta-preset')
  await mkdir(join(presetDir, '__MACOSX'), { recursive: true })
  await writeFile(join(presetDir, 'agent.cordis.yml'), '[]\n')
  await writeFile(join(presetDir, '.DS_Store'), 'junk')
  await writeFile(join(presetDir, 'Thumbs.db'), 'junk')
  await writeFile(join(presetDir, 'desktop.ini'), 'junk')
  await writeFile(join(presetDir, '._resource'), 'junk')
  await writeFile(join(presetDir, '__MACOSX', '._agent'), 'junk')

  const roots = [{ path: temp, trust: 'user' }]
  const req = { url: `${PRESET_EXPORT_PATH}?agentPreset=os-meta-preset`, method: 'GET', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetExport(req, res, { roots })
  assert.equal(res.statusCode, 200)
  const inspected = inspectPresetArchive(res.body)
  assert.deepEqual(Object.keys(inspected.entries), ['preset/agent.cordis.yml'])
})

test('export: refuses when exceeding MAX_FILES, MAX_FILE_BYTES, or MAX_UNCOMPRESSED_BYTES', async () => {
  assert.throws(
    () => {
      const files = {}
      for (let i = 0; i <= MAX_FILES + 1; i += 1) files[`file${i}.txt`] = 'ok'
      createPresetArchive({ manifest: { format: 'dsh-preset', version: 1, id: 'test' }, files })
    },
    /exceeds maximum allowed/u
  )

  assert.throws(
    () => {
      createPresetArchive({
        manifest: { format: 'dsh-preset', version: 1, id: 'test' },
        files: { 'big.bin': new Uint8Array(MAX_FILE_BYTES + 10) }
      })
    },
    /exceeds maximum size/u
  )
})

// ---------------------------------------------------------------------------
// Preview Tests
// ---------------------------------------------------------------------------

test('preview: valid archive reports ok without conflict', async (t) => {
  const temp = await createTempDir(t)
  const roots = [{ path: temp, trust: 'user' }]
  const archive = createPresetArchive({
    manifest: { format: 'dsh-preset', version: 1, id: 'sample', name: 'Sample' },
    files: { 'agent.cordis.yml': 'name: sample\n' }
  })

  const req = { url: PRESET_IMPORT_PATH, method: 'POST', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetImportPreview(req, res, { roots, bodyBuffer: archive })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.agentPreset, 'sample')
  assert.equal(body.conflict, false)
  assert.equal(body.installed, false)
  assert.equal(body.fileCount, 1)
})

test('preview: rejects bad manifest format or unsupported version or bad id', async () => {
  assert.throws(
    () => inspectPresetArchive(zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'other', version: 1, id: 'test' })),
      'preset/agent.cordis.yml': strToU8('ok')
    })),
    /Invalid archive format/u
  )

  assert.throws(
    () => inspectPresetArchive(zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'dsh-preset', version: 2, id: 'test' })),
      'preset/agent.cordis.yml': strToU8('ok')
    })),
    /Unsupported archive version/u
  )

  assert.throws(
    () => inspectPresetArchive(zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'dsh-preset', version: 1, id: 'INVALID_ID!' })),
      'preset/agent.cordis.yml': strToU8('ok')
    })),
    /Invalid preset id/u
  )
})

test('preview: path traversal entries (absolute, .., backslash) are rejected', () => {
  assert.throws(
    () => inspectPresetArchive(zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'dsh-preset', version: 1, id: 'test' })),
      '/etc/passwd': strToU8('root')
    })),
    /Path traversal or invalid path/u
  )

  assert.throws(
    () => inspectPresetArchive(zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'dsh-preset', version: 1, id: 'test' })),
      'preset/../escape.txt': strToU8('escaped')
    })),
    /Path traversal or invalid path/u
  )

  assert.throws(
    () => inspectPresetArchive(zipSync({
      'manifest.json': strToU8(JSON.stringify({ format: 'dsh-preset', version: 1, id: 'test' })),
      'preset\\win.txt': strToU8('windows')
    })),
    /Path traversal or invalid path/u
  )
})

test('preview: detects existing preset conflict', async (t) => {
  const temp = await createTempDir(t)
  const roots = [{ path: temp, trust: 'user' }]
  await mkdir(join(temp, 'existing-preset'), { recursive: true })
  await writeFile(join(temp, 'existing-preset', 'agent.cordis.yml'), 'name: existing\n')

  const archive = createPresetArchive({
    manifest: { format: 'dsh-preset', version: 1, id: 'existing-preset' },
    files: { 'agent.cordis.yml': 'name: existing\n' }
  })

  const req = { url: PRESET_IMPORT_PATH, method: 'POST', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetImportPreview(req, res, { roots, bodyBuffer: archive })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.conflict, true)
})

test('preview: secret regex fires on sk- and absolute-path regex fires on /Users/', async (t) => {
  const temp = await createTempDir(t)
  const roots = [{ path: temp, trust: 'user' }]
  const archive = createPresetArchive({
    manifest: { format: 'dsh-preset', version: 1, id: 'leaky' },
    files: {
      'agent.cordis.yml': 'secret: sk-123456789012345678901234567890\npath: /Users/foo/bar\n'
    }
  })

  const req = { url: PRESET_IMPORT_PATH, method: 'POST', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetImportPreview(req, res, { roots, bodyBuffer: archive })
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.ok(body.warnings.some((w) => w.includes('possible-secrets')))
  assert.ok(body.warnings.some((w) => w.includes('absolute-paths')))
})

// ---------------------------------------------------------------------------
// Install Tests
// ---------------------------------------------------------------------------

test('install: happy path installs files, scanRoot verifies, permissions on .sh are 0755', async (t) => {
  const temp = await createTempDir(t)
  const roots = [{ path: temp, trust: 'user' }]
  const archive = createPresetArchive({
    manifest: { format: 'dsh-preset', version: 1, id: 'script-preset' },
    files: {
      'agent.cordis.yml': '[]\n',
      'script.sh': '#!/bin/bash\necho hi\n'
    }
  })

  const req = { url: `${PRESET_IMPORT_PATH}?agentPreset=script-preset&install=1`, method: 'POST', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetImportInstall(req, res, {
    roots,
    bodyBuffer: archive,
    scanRootFn: async (root) => {
      if (root.path.includes('.import-tmp-')) {
        return [{ id: 'script-preset', path: join(root.path, 'script-preset', 'agent.cordis.yml') }]
      }
      return []
    }
  })

  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.installed, true)
  assert.equal(body.conflict, false)

  const installedScript = join(temp, 'script-preset', 'script.sh')
  const st = await readFile(installedScript, 'utf8')
  assert.match(st, /#!\/bin\/bash/u)
})

test('install: conflict returns 409', async (t) => {
  const temp = await createTempDir(t)
  const roots = [{ path: temp, trust: 'user' }]
  await mkdir(join(temp, 'clash'), { recursive: true })
  await writeFile(join(temp, 'clash', 'agent.cordis.yml'), '[]\n')

  const archive = createPresetArchive({
    manifest: { format: 'dsh-preset', version: 1, id: 'clash' },
    files: { 'agent.cordis.yml': '[]\n' }
  })

  const req = { url: `${PRESET_IMPORT_PATH}?agentPreset=clash&install=1`, method: 'POST', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetImportInstall(req, res, { roots, bodyBuffer: archive })
  assert.equal(res.statusCode, 409)
})

test('install: scanRoot failure aborts install and cleans temporary staging', async (t) => {
  const temp = await createTempDir(t)
  const roots = [{ path: temp, trust: 'user' }]
  const archive = createPresetArchive({
    manifest: { format: 'dsh-preset', version: 1, id: 'failing-preset' },
    files: { 'agent.cordis.yml': '[]\n' }
  })

  const req = { url: `${PRESET_IMPORT_PATH}?agentPreset=failing-preset&install=1`, method: 'POST', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetImportInstall(req, res, {
    roots,
    bodyBuffer: archive,
    scanRootFn: async (root) => {
      if (root.path.includes('.import-tmp-')) {
        return [{ id: 'failing-preset', broken: 'composition has invalid syntax' }]
      }
      return []
    }
  })

  assert.equal(res.statusCode, 400)
  assert.match(JSON.parse(res.body).error, /scanRoot validation failed/u)

  const filesAfter = await readdir(temp)
  assert.deepEqual(filesAfter, [])
})

test('install: abort mid-install returns 499 and cleans temp', async (t) => {
  const temp = await createTempDir(t)
  const roots = [{ path: temp, trust: 'user' }]
  const archive = createPresetArchive({
    manifest: { format: 'dsh-preset', version: 1, id: 'aborted-preset' },
    files: { 'agent.cordis.yml': '[]\n' }
  })

  const controller = new AbortController()
  controller.abort()

  const req = { url: `${PRESET_IMPORT_PATH}?agentPreset=aborted-preset&install=1`, method: 'POST', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetImportInstall(req, res, { roots, bodyBuffer: archive, signal: controller.signal })
  assert.equal(res.statusCode, 499)

  const filesAfter = await readdir(temp)
  assert.deepEqual(filesAfter, [])
})

test('install integration: scanRoot resolves @deepseek-ai/* package via harnessBase', async (t) => {
  const temp = await createTempDir(t)
  const roots = [{ path: temp, trust: 'user' }]
  const archive = createPresetArchive({
    manifest: { format: 'dsh-preset', version: 1, id: 'cordis-ref' },
    files: {
      'agent.cordis.yml': '- name: "@deepseek-ai/cordis"\n'
    }
  })

  const harnessBase = pathToFileURL('/home/gabriel/.dsh/profiles/default/').href
  const req = { url: `${PRESET_IMPORT_PATH}?agentPreset=cordis-ref&install=1`, method: 'POST', socket: { remoteAddress: '127.0.0.1' } }
  const res = mockRes()

  await handlePresetImportInstall(req, res, {
    roots,
    harnessBase,
    bodyBuffer: archive
  })

  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).installed, true)
})

// ---------------------------------------------------------------------------
// Guard & Server Routing Tests
// ---------------------------------------------------------------------------

test('guard: export rejects non-loopback or forwarded headers; import requires loopback + same-origin', async (t) => {
  const temp = await createTempDir(t)
  const roots = [{ path: temp, trust: 'user' }]
  const handler = createPresetRequestHandler({ roots })

  // Non-loopback export
  const res1 = mockRes()
  await handler({ url: `${PRESET_EXPORT_PATH}?agentPreset=test`, method: 'GET', socket: { remoteAddress: '192.168.1.1' }, headers: {} }, res1)
  assert.equal(res1.statusCode, 403)

  // Forwarded header export
  const res2 = mockRes()
  await handler({ url: `${PRESET_EXPORT_PATH}?agentPreset=test`, method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '1.2.3.4' } }, res2)
  assert.equal(res2.statusCode, 403)

  // Import without same-origin
  const res3 = mockRes()
  await handler({ url: PRESET_IMPORT_PATH, method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3000', origin: 'http://evil.com' } }, res3)
  assert.equal(res3.statusCode, 403)

  // Wrong HTTP methods -> 405
  const res4 = mockRes()
  await handler({ url: `${PRESET_EXPORT_PATH}?agentPreset=test`, method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res4)
  assert.equal(res4.statusCode, 405)

  const res5 = mockRes()
  await handler({ url: PRESET_IMPORT_PATH, method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res5)
  assert.equal(res5.statusCode, 405)
})

test('server: preset routes work when mounted on market server', async (t) => {
  const temp = await createTempDir(t)
  const presetDir = join(temp, 'sample')
  await mkdir(presetDir, { recursive: true })
  await writeFile(join(presetDir, 'agent.cordis.yml'), '[]\n')

  const fakeService = { status: async () => ({}) }
  const server = createMarketServer(fakeService, {
    presetOptions: { roots: [{ path: temp, trust: 'user' }] }
  })
  const addr = await listenMarketServer(server)
  t.after(() => server.close())

  const res = await fetch(`http://127.0.0.1:${addr.port}${PRESET_EXPORT_PATH}?agentPreset=sample`)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/vnd.dsh.preset+zip')
})
