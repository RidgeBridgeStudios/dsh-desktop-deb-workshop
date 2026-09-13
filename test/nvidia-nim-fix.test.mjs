import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isNimEndpoint,
  transformNimRequestBody,
  apply,
  name
} from '../opt/dsh-desktop/plugins/dsh-nvidia-nim-fix/index.js'

test('plugin metadata', () => {
  assert.equal(name, '@dsh-desktop/dsh-nvidia-nim-fix')
})

test('isNimEndpoint matches exact NVIDIA NIM hostname', () => {
  assert.equal(isNimEndpoint('https://integrate.api.nvidia.com/v1/chat/completions'), true)
  assert.equal(isNimEndpoint('https://integrate.api.nvidia.com'), true)
  assert.equal(isNimEndpoint(new URL('https://integrate.api.nvidia.com/v1/chat/completions')), true)
  // Negative checks
  assert.equal(isNimEndpoint('https://api.nvidia.com/v1/models'), false)
  assert.equal(isNimEndpoint('https://api.nvidia.com'), false)
  assert.equal(isNimEndpoint('https://evil-integrate.api.nvidia.com.attacker.tld'), false)
  assert.equal(isNimEndpoint('https://api.deepseek.com/v1/chat/completions'), false)
  assert.equal(isNimEndpoint('https://api.openai.com/v1/chat/completions'), false)
  assert.equal(isNimEndpoint('not-a-url'), false)
})

test('transformNimRequestBody adds chat_template_kwargs and preserves user-chosen reasoning_effort', () => {
  // Test A: Default injects reasoning_effort: "high" and deletes conflicting thinking field
  const inputA = {
    model: 'deepseek-ai/deepseek-v4-flash',
    thinking: { type: 'disabled' },
    messages: [
      { role: 'developer', content: 'Act as coding assistant' },
      { role: 'user', content: 'Hello' }
    ]
  }

  const resA = transformNimRequestBody(inputA)
  assert.equal(resA.modified, true)
  assert.equal(resA.body.thinking, undefined)
  assert.deepEqual(resA.body.chat_template_kwargs, {
    thinking: true,
    reasoning_effort: 'high'
  })
  assert.equal(resA.body.messages[0].role, 'system')
  assert.equal(resA.body.messages[1].role, 'user')

  // Test B: Preserves user-chosen reasoning_effort
  const inputB = {
    model: 'deepseek-ai/deepseek-v4-pro',
    chat_template_kwargs: {
      reasoning_effort: 'medium',
      custom_flag: true
    },
    messages: [{ role: 'user', content: 'Hi' }]
  }

  const resB = transformNimRequestBody(inputB)
  assert.equal(resB.modified, true)
  assert.equal(resB.body.chat_template_kwargs.thinking, true)
  assert.equal(resB.body.chat_template_kwargs.reasoning_effort, 'medium')
  assert.equal(resB.body.chat_template_kwargs.custom_flag, true)
})

test('transformNimRequestBody does not inject chat_template_kwargs for non-deepseek-v4 models but remaps developer role', () => {
  const input = {
    model: 'meta/llama-3.3-70b-instruct',
    messages: [
      { role: 'developer', content: 'Instructions' },
      { role: 'user', content: 'Query' }
    ]
  }

  const { body, modified } = transformNimRequestBody(input)
  assert.equal(modified, true)
  assert.equal(body.chat_template_kwargs, undefined)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].role, 'user')
})

test('wrapper transforms a real Request object', async () => {
  let captured = null
  const orig = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    captured = init?.body ?? (input instanceof Request ? await input.clone().text() : null)
    return new Response('{}', { status: 200 })
  }

  apply()

  const req = new Request('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-ai/deepseek-v4-flash',
      messages: [{ role: 'developer', content: 'system-like prompt' }]
    })
  })

  await globalThis.fetch(req)
  globalThis.fetch = orig
  delete globalThis[Symbol.for('dsh.nvidia.nim.fix.installed')]

  assert.ok(captured)
  const parsed = JSON.parse(captured)
  assert.equal(parsed.chat_template_kwargs.thinking, true)
  assert.equal(parsed.chat_template_kwargs.reasoning_effort, 'high')
  assert.equal(parsed.messages[0].role, 'system')
})

test('idempotency: calling apply() twice wraps fetch only once', () => {
  const orig = globalThis.fetch
  globalThis.fetch = () => new Response('{}')

  apply()
  const firstWrapper = globalThis.fetch
  assert.equal(firstWrapper.__isNimFix, true)

  apply()
  const secondWrapper = globalThis.fetch
  assert.equal(firstWrapper, secondWrapper)

  globalThis.fetch = orig
  delete globalThis[Symbol.for('dsh.nvidia.nim.fix.installed')]
})

test('postinst patch logic creates backups and refuses non-list files', async () => {
  const { execSync } = await import('node:child_process')
  const { mkdtemp, readFile, writeFile, readdir, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const testDir = await mkdtemp(join(tmpdir(), 'dsh-postinst-test-'))
  const dshDir = join(testDir, '.dsh')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(dshDir, { recursive: true })

  // Plant a non-list file
  const invalidFile = join(dshDir, 'cordis.patch.yml')
  await writeFile(invalidFile, 'foo: bar\n')

  const script = `
    apply_nim_fix_patch() {
      local target_home="$1"
      local dsh_dir="$target_home/.dsh"
      local profile_dir="$dsh_dir/profiles/default"
      mkdir -p "$dsh_dir" "$profile_dir"
      local patch_block="- insert:
    - id: dsh-nvidia-nim-fix
      name: /opt/dsh-desktop/plugins/dsh-nvidia-nim-fix/index.js"

      for pfile in "$dsh_dir/cordis.patch.yml" "$profile_dir/cordis.patch.yml"; do
        if [ ! -f "$pfile" ] || [ ! -s "$pfile" ]; then
          printf "%s\\n" "$patch_block" > "$pfile"
        else
          if ! head -c 1 "$pfile" | grep -qE '^(-|\\[|\\s*$)' ; then
            cp "$pfile" "$pfile.bak.12345"
            continue
          fi
          if ! grep -q "dsh-nvidia-nim-fix" "$pfile" 2>/dev/null; then
            cp "$pfile" "$pfile.bak.12345"
            if grep -q '^[[:space:]]*\\[\\][[:space:]]*$' "$pfile" 2>/dev/null; then
              sed -i 's/^[[:space:]]*\\[\\][[:space:]]*$//' "$pfile"
            fi
            printf "\\n%s\\n" "$patch_block" >> "$pfile"
          fi
        fi
      done
    }
    apply_nim_fix_patch "${testDir}"
  `
  execSync(script, { shell: '/bin/bash' })

  // Assert invalid file was not corrupted
  const content = await readFile(invalidFile, 'utf8')
  assert.equal(content, 'foo: bar\n')

  // Assert backup was created
  const files = await readdir(dshDir)
  assert.ok(files.some(f => f.includes('.bak.')))

  await rm(testDir, { recursive: true, force: true })
})
