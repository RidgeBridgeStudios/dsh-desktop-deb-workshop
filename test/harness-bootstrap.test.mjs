import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  inferFailurePackage,
  runHarnessEntry
} from '../usr/share/dsh-desktop/lib/plugin-manager/harness-bootstrap.mjs'
import { parsePluginStartupFailures } from '../usr/share/dsh-desktop/lib/plugin-manager/startup-failure.mjs'

test('infers a package name from a resolution failure message', () => {
  assert.equal(inferFailurePackage("Cannot find package 'leaf-module'"), 'leaf-module')
  assert.equal(inferFailurePackage("Cannot find package '@scope/leaf'"), '@scope/leaf')
  assert.equal(inferFailurePackage('some other failure'), undefined)
})

test('a failing entry emits one structured report and rethrows', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const entry = join(dir, 'entry.mjs')
  await writeFile(entry, "throw new Error(\"Cannot find package 'leaf-module'\")\n", 'utf8')

  const reports = []
  await assert.rejects(
    () => runHarnessEntry({ entryPath: entry, report: (failure) => reports.push(failure) }),
    /leaf-module/u
  )
  assert.equal(reports.length, 1)
  assert.equal(reports[0].stage, 'import')
  assert.equal(reports[0].packageName, 'leaf-module')
  assert.equal(reports[0].config, undefined)

  const lines = []
  await runHarnessEntry({
    entryPath: entry,
    report: (failure) => lines.push(failure)
  }).catch(() => undefined)
  assert.equal(lines.length, 1)
})

test('a successful entry emits no report', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-bootstrap-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const entry = join(dir, 'entry.mjs')
  await writeFile(entry, 'export const ok = true\n', 'utf8')

  let called = false
  const result = await runHarnessEntry({ entryPath: entry, report: () => { called = true } })
  assert.equal(result.ok, true)
  assert.equal(called, false)
  assert.equal(parsePluginStartupFailures(''), undefined)
})
