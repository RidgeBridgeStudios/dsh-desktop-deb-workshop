import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pickerPath = join(__dirname, '..', 'usr', 'share', 'dsh-desktop', 'app', 'profile-picker.html')

test('profile-picker.html contains all required UI element IDs', async () => {
  const html = await readFile(pickerPath, 'utf8')

  const expectedIds = [
    'profile-list',
    'snapshot-list',
    'btn-use',
    'btn-create',
    'btn-rename',
    'btn-delete',
    'btn-snapshot-create',
    'btn-restore',
    'btn-cancel',
    'name-input',
    'display-input',
    'color-input',
    'confirm-input',
    'status-msg'
  ]

  for (const id of expectedIds) {
    assert.ok(
      html.includes(`id="${id}"`),
      `profile-picker.html must contain element with id="${id}"`
    )
  }
})

test('profile-picker.html enforces strict XSS protection with zero innerHTML usage', async () => {
  const html = await readFile(pickerPath, 'utf8')
  assert.equal(
    html.includes('innerHTML'),
    false,
    'profile-picker.html must not use innerHTML; strictly use textContent and safe DOM construction'
  )
})

test('profile-picker.html interacts only through window.dshProfiles bridge', async () => {
  const html = await readFile(pickerPath, 'utf8')
  assert.ok(html.includes('window.dshProfiles.list'))
  assert.ok(html.includes('window.dshProfiles.create'))
  assert.ok(html.includes('window.dshProfiles.rename'))
  assert.ok(html.includes('window.dshProfiles.delete'))
  assert.ok(html.includes('window.dshProfiles.snapshots'))
  assert.ok(html.includes('window.dshProfiles.restore'))
  assert.ok(html.includes('window.dshProfiles.pickerResolve'))
})
