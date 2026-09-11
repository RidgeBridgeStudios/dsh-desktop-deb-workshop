import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'

import {
  LIVE_PROFILE,
  dshHome,
  installationClosureDir,
  profileDirectory,
  profilesRoot
} from '../usr/share/dsh-desktop/lib/plugin-manager/paths.mjs'

test('defaults to ~/.dsh when DSH_HOME is absent or blank', () => {
  assert.equal(dshHome({}), join(homedir(), '.dsh'))
  assert.equal(dshHome({ DSH_HOME: '' }), join(homedir(), '.dsh'))
  assert.equal(dshHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
})

test('honours DSH_HOME when set', () => {
  assert.equal(dshHome({ DSH_HOME: '/srv/state/dsh' }), '/srv/state/dsh')
})

test('targets the live profile, not the reference web profile', () => {
  assert.equal(LIVE_PROFILE, 'default')
  assert.equal(profileDirectory('/h'), join('/h', 'profiles', 'default'))
  assert.equal(profilesRoot('/h'), join('/h', 'profiles'))
  assert.equal(installationClosureDir('/h'), join('/h', 'profiles', 'node_modules'))
})

test('accepts an explicit profile name', () => {
  assert.equal(profileDirectory('/h', 'desktop-safe-mode'), join('/h', 'profiles', 'desktop-safe-mode'))
})
