/**
 * @dsh-desktop/dsh-nvidia-nim-fix
 *
 * DSH plugin providing request pipeline transformation for NVIDIA NIM endpoints.
 * Resolves DeepSeek-v4 streaming hang by injecting chat_template_kwargs and
 * remapping developer role messages to system.
 *
 * Interception mechanism:
 * In DSH (@deepseek-ai/dsh-llm-pi-ai / @earendil-works/pi-ai), the OpenAI client is constructed
 * per stream call (streamOpenAICompletions) without caching, which dynamically binds globalThis.fetch.
 * Because DSH lacks an HTTP middleware seam (no ctx.http/ctx.fetch/ctx.network), wrapping
 * globalThis.fetch at plugin initialization guarantees that all subsequently executed NIM calls
 * are transformed.
 */

export const name = '@dsh-desktop/dsh-nvidia-nim-fix';
const SENTINEL = Symbol.for('dsh.nvidia.nim.fix.installed');

/**
 * Validates if the destination URL matches the exact NVIDIA NIM API hostname.
 */
export function isNimEndpoint(url) {
  try {
    const raw = typeof url === 'string' ? url : url instanceof URL ? url.href : url?.url;
    if (!raw) return false;
    const h = new URL(raw).hostname;
    return h === 'integrate.api.nvidia.com';
  } catch {
    return false;
  }
}

/**
 * Transforms request payload:
 * 1. Checks if model ID contains 'deepseek-v4'. If so, injects chat_template_kwargs,
 *    preserving any user-chosen reasoning_effort.
 * 2. Remaps any message with role: 'developer' to role: 'system'.
 */
export function transformNimRequestBody(body) {
  let modified = false;

  if (Array.isArray(body.messages)) {
    const updatedMessages = body.messages.map((msg) => {
      if (msg && msg.role === 'developer') {
        modified = true;
        return { ...msg, role: 'system' };
      }
      return msg;
    });
    if (modified) {
      body.messages = updatedMessages;
    }
  }

  if (typeof body.model === 'string' && body.model.toLowerCase().includes('deepseek-v4')) {
    if ('thinking' in body) {
      delete body.thinking;
      modified = true;
    }
    const existing = body.chat_template_kwargs || {};
    body.chat_template_kwargs = {
      thinking: true,
      ...existing,
      reasoning_effort: existing.reasoning_effort ?? 'high',
    };
    modified = true;
  }

  return { body, modified };
}

/**
 * Hooks into globalThis.fetch to intercept outbound requests to NVIDIA NIM.
 */
export function apply(ctx) {
  console.error('[nim-fix] apply() invoked; fetch wrapped =', typeof globalThis.fetch);
  if (globalThis[SENTINEL] || globalThis.fetch?.__isNimFix) {
    return;
  }

  const originalFetch = globalThis.fetch;

  const patchedFetch = async function (input, init) {
    try {
      const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      if (rawUrl && isNimEndpoint(rawUrl)) {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          if (input.method === 'POST' && !input.bodyUsed) {
            try {
              const clone = input.clone();
              const text = await clone.text();
              if (text) {
                const parsed = JSON.parse(text);
                const { body: transformed, modified } = transformNimRequestBody(parsed);
                if (modified) {
                  input = new Request(input, { body: JSON.stringify(transformed) });
                }
              }
            } catch (e) {
              if (process.env.DSH_DEBUG) {
                console.debug('[nim-fix] transform failed on Request object:', e);
              }
            }
          }
        } else if (init && (!init.method || init.method.toUpperCase() === 'POST')) {
          if (typeof init.body === 'string') {
            try {
              const parsed = JSON.parse(init.body);
              const { body: transformed, modified } = transformNimRequestBody(parsed);
              if (modified) {
                init.body = JSON.stringify(transformed);
              }
            } catch (e) {
              if (process.env.DSH_DEBUG) {
                console.debug('[nim-fix] transform failed on init.body:', e);
              }
            }
          }
        }
      }
    } catch (e) {
      if (process.env.DSH_DEBUG) {
        console.debug('[nim-fix] top-level interceptor error:', e);
      }
    }

    return originalFetch.call(globalThis, input, init);
  };

  patchedFetch.__isNimFix = true;
  globalThis[SENTINEL] = true;
  globalThis.fetch = patchedFetch;

  if (ctx && typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      if (globalThis.fetch === patchedFetch) {
        globalThis.fetch = originalFetch;
        delete globalThis[SENTINEL];
      }
    });
  }
}

export function __resetForTests() {
  delete globalThis[SENTINEL];
}

export default { name, apply, isNimEndpoint, transformNimRequestBody, __resetForTests };
