import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

import {
  LIVE_PROFILE,
  dshHome,
  profileDirectory,
  profilesRoot
} from '../usr/share/dsh-desktop/lib/plugin-manager/paths.mjs'

const DAEMON = new URL('../usr/lib/dsh-desktop/bin/dsh-desktop-daemon', import.meta.url)
const LAUNCHER = new URL('../usr/lib/dsh-desktop/bin/dsh-desktop', import.meta.url)

test('LIVE_PROFILE is the profile the daemon actually launches', async () => {
  const daemon = await readFile(DAEMON, 'utf8')
  const launched = /--profile\s+([A-Za-z0-9._-]+)/u.exec(daemon)
  assert.ok(launched, 'the daemon must pass --profile to the runtime')
  assert.equal(launched[1], LIVE_PROFILE)

  assert.ok(
    daemon.includes('bootstrap-cli.mjs'),
    'daemon must invoke bootstrap-cli.mjs to seed the profile'
  )
})

test('LIVE_PROFILE is the profile the launcher seeds and starts', async () => {
  const launcher = await readFile(LAUNCHER, 'utf8')
  const launched = launcher.match(/--profile\s+([A-Za-z0-9._-]+)/u)
  assert.ok(launched, 'the launcher must pass --profile to the runtime')
  assert.equal(launched[1], LIVE_PROFILE)

  const seeded = launcher.match(/profiles\/([A-Za-z0-9._-]+)"/u)
  assert.ok(seeded, 'the launcher must seed the profile directory it launches')
  assert.equal(seeded[1], LIVE_PROFILE)
})

test('the live profile directory exists in this environment', async (t) => {
  const home = dshHome()
  const dir = profileDirectory(home)
  const info = await stat(dir).then(
    (value) => value,
    () => undefined
  )
  if (info === undefined) {
    return t.skip(`no live profile at ${dir} (dshHome=${home}, profiles=${profilesRoot(home)})`)
  }
  assert.equal(info.isDirectory(), true)
})
