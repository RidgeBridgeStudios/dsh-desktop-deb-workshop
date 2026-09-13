import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

test('install paths: debian/postinst creates symlinks for binaries and postrm cleans them', () => {
  const postinstPath = path.join(rootDir, 'debian/postinst')
  const postrmPath = path.join(rootDir, 'debian/postrm')

  const postinstContent = fs.readFileSync(postinstPath, 'utf8')
  const postrmContent = fs.readFileSync(postrmPath, 'utf8')

  assert.match(
    postinstContent,
    /ln -sf \/usr\/lib\/dsh-desktop\/bin\/dsh-desktop \/usr\/bin\/dsh-desktop/,
    'postinst must create symlink for dsh-desktop'
  )
  assert.match(
    postinstContent,
    /ln -sf \/usr\/lib\/dsh-desktop\/bin\/dsh-desktop-daemon \/usr\/bin\/dsh-desktop-daemon/,
    'postinst must create symlink for dsh-desktop-daemon'
  )
  assert.match(
    postinstContent,
    /ln -sf \/usr\/lib\/dsh-desktop\/bin\/dsh-desktop-upgrade-helper \/usr\/bin\/dsh-desktop-upgrade-helper/,
    'postinst must create symlink for dsh-desktop-upgrade-helper'
  )

  assert.match(
    postrmContent,
    /rm -f.*\/usr\/bin\/dsh-desktop/,
    'postrm must remove /usr/bin symlinks'
  )
})

test('install paths: service ExecStart matches desktop entry Exec binary path', () => {
  const servicePath = path.join(rootDir, 'lib/systemd/user/dsh-desktop.service')
  const desktopAppPath = path.join(rootDir, 'usr/share/applications/dsh-desktop.desktop')
  const desktopPresetPath = path.join(rootDir, 'usr/share/applications/dsh-desktop-preset.desktop')

  const serviceContent = fs.readFileSync(servicePath, 'utf8')
  const desktopAppContent = fs.readFileSync(desktopAppPath, 'utf8')
  const desktopPresetContent = fs.readFileSync(desktopPresetPath, 'utf8')

  assert.match(serviceContent, /ExecStart=\/usr\/bin\/dsh-desktop-daemon/)
  assert.match(desktopAppContent, /Exec=\/usr\/bin\/dsh-desktop/)
  assert.match(desktopPresetContent, /Exec=\/usr\/bin\/dsh-desktop --import-preset=%f/)
})
