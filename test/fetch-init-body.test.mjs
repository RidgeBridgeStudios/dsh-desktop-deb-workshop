import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, __resetForTests } from '../opt/dsh-desktop/plugins/dsh-nvidia-nim-fix/index.js'

test('fetch transforms init.body string and deletes thinking field', async () => {
  let capturedBody = null
  const origFetch = globalThis.fetch

  globalThis.fetch = async (input, init) => {
    capturedBody = init?.body
    return new Response('{}', { status: 200 })
  }

  try {
    apply()

    const rawPayload = JSON.stringify({
      model: 'deepseek-ai/deepseek-v4-flash-0731',
      messages: [
        { role: 'developer', content: 'system instructions' },
        { role: 'user', content: 'hello' }
      ],
      stream: true,
      thinking: { type: 'disabled' }
    })

    await globalThis.fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawPayload
    })

    assert.ok(capturedBody, 'Expected init.body to be captured')
    const parsed = JSON.parse(capturedBody)

    assert.equal(parsed.thinking, undefined, 'Conflicting thinking field must be deleted')
    assert.deepEqual(parsed.chat_template_kwargs, {
      thinking: true,
      reasoning_effort: 'high'
    }, 'chat_template_kwargs must be injected')
    assert.equal(parsed.messages[0].role, 'system', 'developer role must be remapped to system')
    assert.equal(parsed.messages[1].role, 'user')
  } finally {
    globalThis.fetch = origFetch
    __resetForTests()
  }
})
