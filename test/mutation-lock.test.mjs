import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withMutationLock } from '../usr/share/dsh-desktop/app/main.js'

test('withMutationLock serializes concurrent async operations strictly in order', async () => {
  const log = []
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const p1 = withMutationLock(async () => {
    log.push('start-1')
    await delay(30)
    log.push('end-1')
    return 'res-1'
  })

  const p2 = withMutationLock(async () => {
    log.push('start-2')
    await delay(10)
    log.push('end-2')
    return 'res-2'
  })

  const p3 = withMutationLock(async () => {
    log.push('start-3')
    await delay(5)
    log.push('end-3')
    return 'res-3'
  })

  const results = await Promise.all([p1, p2, p3])

  assert.deepEqual(results, ['res-1', 'res-2', 'res-3'])
  assert.deepEqual(log, [
    'start-1',
    'end-1',
    'start-2',
    'end-2',
    'start-3',
    'end-3'
  ])
})

test('withMutationLock recovers gracefully when a mutation throws and runs subsequent tasks', async () => {
  const log = []

  const pFail = withMutationLock(async () => {
    log.push('failing-op')
    throw new Error('mutation failure')
  })

  const pSuccess = withMutationLock(async () => {
    log.push('subsequent-op')
    return 'success'
  })

  await assert.rejects(() => pFail, /mutation failure/)
  const res = await pSuccess

  assert.equal(res, 'success')
  assert.deepEqual(log, ['failing-op', 'subsequent-op'])
})
