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

test('install paths: debian/postrm has distinct remove) and purge) arms with apparmor_parser in purge only', () => {
  const postrmPath = path.join(rootDir, 'debian/postrm')
  const postrmContent = fs.readFileSync(postrmPath, 'utf8')

  assert.doesNotMatch(postrmContent, /remove\|purge\)/, 'remove and purge arms must be separate')
  assert.match(postrmContent, /remove\)/, 'postrm must contain remove) arm')
  assert.match(postrmContent, /purge\)/, 'postrm must contain purge) arm')

  const removeArmMatch = postrmContent.match(/remove\)([\s\S]*?);;/)
  const purgeArmMatch = postrmContent.match(/purge\)([\s\S]*?);;/)

  assert.ok(removeArmMatch, 'remove) arm must terminate with ;;')
  assert.ok(purgeArmMatch, 'purge) arm must terminate with ;;')

  assert.doesNotMatch(removeArmMatch[1], /apparmor_parser -R/, 'remove arm must not unload AppArmor')
  assert.match(purgeArmMatch[1], /apparmor_parser -R/, 'purge arm must unload AppArmor')
})

test('install paths: postinst uses runuser and conditional linger, build.sh references enabled unattended-upgrades', () => {
  const postinstPath = path.join(rootDir, 'debian/postinst')
  const buildShPath = path.join(rootDir, 'build.sh')

  const postinstContent = fs.readFileSync(postinstPath, 'utf8')
  const buildShContent = fs.readFileSync(buildShPath, 'utf8')

  assert.doesNotMatch(postinstContent, /sudo -u/, 'postinst must not use sudo -u')
  assert.match(postinstContent, /runuser -u/, 'postinst must use runuser -u')
  assert.match(postinstContent, /\/etc\/dsh-desktop\/linger-enabled/, 'postinst must check linger-enabled')
  assert.match(buildShContent, /etc\/apt\/apt\.conf\.d\/51dsh-desktop-unattended-upgrades["\s]/, 'build.sh must reference non-.disabled unattended-upgrades file')
})
