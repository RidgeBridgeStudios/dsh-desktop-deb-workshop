import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOCALES, SUPPORTED_LOCALES } from '../usr/share/dsh-desktop/lib/plugin-manager/locales.mjs'

test('locales define supported languages en and zh', () => {
  assert.ok(SUPPORTED_LOCALES.includes('en'))
  assert.ok(SUPPORTED_LOCALES.includes('zh'))
})

test('all translation keys match symmetrically between en and zh', () => {
  const enKeys = Object.keys(LOCALES.en)
  const zhKeys = Object.keys(LOCALES.zh)

  assert.equal(enKeys.length, zhKeys.length)

  const missingInZh = enKeys.filter((k) => !zhKeys.includes(k))
  const missingInEn = zhKeys.filter((k) => !enKeys.includes(k))

  assert.deepEqual(missingInZh, [])
  assert.deepEqual(missingInEn, [])
})

test('translation placeholders match between en and zh', () => {
  const paramRegex = /\{([a-zA-Z0-9_]+)\}/g

  for (const key of Object.keys(LOCALES.en)) {
    const enParams = (LOCALES.en[key].match(paramRegex) || []).sort()
    const zhParams = (LOCALES.zh[key].match(paramRegex) || []).sort()
    assert.deepEqual(
      enParams,
      zhParams,
      `Placeholder mismatch in key "${key}": en has ${JSON.stringify(enParams)}, zh has ${JSON.stringify(zhParams)}`
    )
  }
})

test('multi-profile keys are present in all locales', () => {
  const profileKeys = [
    'menuSwitchProfile',
    'profilePickerTitle',
    'profileCreate',
    'profileRename',
    'profileDelete',
    'profileRestore',
    'profileSnapshots',
    'profileSnapshotCreate',
    'trayProfileLabel'
  ]

  for (const key of profileKeys) {
    assert.ok(LOCALES.en[key], `Missing en key: ${key}`)
    assert.ok(LOCALES.zh[key], `Missing zh key: ${key}`)
  }
})
