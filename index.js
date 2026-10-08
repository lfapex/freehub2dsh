/**
 * freehub2dsh — the dsh shell for a free-model-hub daemon.
 *
 * The hub (https://github.com/lfapex/free-model-hub) is a standalone daemon
 * owning every lane: the anonymous free lane, Kilo, the 13 account channels,
 * the user's relays. This plugin owns only two things:
 *
 * 1. registering the hub's roster into dsh's model picker, refreshing it
 *    from the hub's /hub-models endpoint;
 * 2. proxying each turn to the hub's OpenAI-compatible endpoint and
 *    re-emitting the answer as dsh chunks.
 *
 * Zero configuration on the machine that runs the hub: the server key is
 * read straight from the hub data directory, and a daemon that is not
 * running is started from PATH (`free-model-hub`) as a detached process —
 * installing the plugin is the whole setup. Explicit overrides live in
 * dsh's plugin settings (`hubBaseUrl` / `hubKey`) or in
 * `<DSH_HOME>/freehub2dsh/endpoint.json` for headless hosts.
 *
 * Nothing here talks to an upstream provider, and nothing here stores more
 * than the hub's address: uninstalling the shell never orphans a credential.
 *
 * @module index.js
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'freehub2dsh'

/** Wait for the llm service so the hub adapter can register into the picker. */
export const inject = ['llm']

const DEFAULT_BASE = 'http://127.0.0.1:8330'
const HUB_HOME = path.join(homedir(), '.free-model-hub')
const HUB_SETTINGS = path.join(HUB_HOME, 'hub', 'settings.json')
const START_TIMEOUT_MS = 30000
const REFRESH_MS = 5 * 60000

export function apply(ctx, config) {
  const logger = ctx.logger ?? console

  if (config?.hubEnabled === false) {
    logger.info?.('freehub2dsh: disabled in its dsh settings; nothing registered')
    return
  }

  const settings = resolveEndpoint(config)
  const state = {
    /** @type {Array<{id: string, name: string, contextWindow: number, maxOutput: number, vision: boolean, efforts?: string[]}>} */
    roster: [],
    byId: new Map(),
  }

  const adapter = {
    providerInfo: () => ({ id: 'freehub2dsh', name: 'Free Model Hub' }),

    imageRequestPricing: () => undefined,

    async listModels(provider) {
      return state.roster.map(entry => ({
        provider,
        id: entry.id,
        name: entry.name,
        description: `${entry.vision ? 'vision + text' : 'text'} · ${Math.round(entry.contextWindow / 1024)}K context`,
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      }))
    },

    async resolveModel(provider, model) {
      const entry = state.byId.get(model)
      if (entry === undefined) {
        return { provider, id: model, name: model, context: { contextWindow: 131072 }, defaultMaxTokens: 8192 }
      }
      return {
        provider,
        id: entry.id,
        name: entry.name,
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
        context: { contextWindow: entry.contextWindow },
        defaultMaxTokens: Math.min(entry.maxOutput, 32768),
        ...(Array.isArray(entry.efforts) && entry.efforts.length > 0
          ? { reasoning: { efforts: entry.efforts, defaultEffort: entry.efforts[entry.efforts.length - 1] } }
          : {}),
      }
    },

    async prepareCall(provider, model) {
      return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
    },

    /**
     * One turn: dsh options → hub `chat/completions` (SSE) → dsh chunks.
     */
    async * stream(options) {
      const controller = new AbortController()
      const onAbort = () => controller.abort(options.signal?.reason)
      if (options.signal?.aborted === true) onAbort()
      else options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        await ensureDaemon(logger, settings)
        const response = await fetch(`${settings.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers: hubHeaders(settings),
          body: JSON.stringify({
            model: options.model,
            ...(typeof options.system === 'string' && options.system !== '' ? { messages: [{ role: 'system', content: options.system }, ...toWireMessages(options.messages)] } : { messages: toWireMessages(options.messages) }),
            ...(Array.isArray(options.tools) && options.tools.length > 0 ? { tools: toWireTools(options.tools) } : {}),
            ...(typeof options.temperature === 'number' ? { temperature: options.temperature } : {}),
            ...(typeof options.maxTokens === 'number' ? { max_tokens: options.maxTokens } : {}),
            ...(typeof options.reasoningEffort === 'string' ? { reasoning_effort: options.reasoningEffort } : {}),
            stream: true,
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          let message = text.slice(0, 300) || `HTTP ${response.status}`
          try { message = JSON.parse(text)?.error?.message ?? message } catch { /* plain text */ }
          yield { type: 'finish', reason: { kind: 'error', failure: { message: `free-model-hub: ${message}`, code: response.status === 401 ? 'INVALID_CREDENTIAL' : response.status >= 500 ? 'SERVER' : 'CLIENT_ERROR' } } }
          return
        }
        const body = response.body
        if (body === null) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'free-model-hub: empty response body', code: 'EMPTY_RESPONSE' } } }
          return
        }
        const reader = body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let usage
        let finish
        while (true) {
          const row = await reader.read()
          if (row.done) break
          buffer += decoder.decode(row.value, { stream: true })
          let nl
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (line === '' || line.startsWith(':')) continue
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') continue
            let event
            try { event = JSON.parse(payload) } catch { continue }
            if (event.error !== undefined) {
              yield { type: 'finish', reason: { kind: 'error', failure: { message: String(event.error?.message ?? 'hub error'), code: 'SERVER' } } }
              return
            }
            const delta = event.choices?.[0]?.delta
            if (delta !== undefined) {
              if (typeof delta.content === 'string' && delta.content !== '') yield { type: 'text-delta', text: delta.content }
              if (typeof delta.reasoning === 'string' && delta.reasoning !== '') yield { type: 'reasoning-delta', text: delta.reasoning }
              if (Array.isArray(delta.tool_calls)) {
                for (const call of delta.tool_calls) {
                  yield {
                    type: 'tool-call-delta',
                    index: call.index ?? 0,
                    ...(call.id !== undefined ? { id: call.id } : {}),
                    ...(call.function?.name !== undefined ? { name: call.function.name } : {}),
                    ...(call.function?.arguments !== undefined ? { argumentsDelta: call.function.arguments } : {}),
                  }
                }
              }
            }
            if (event.usage !== undefined) usage = event.usage
            const reason = event.choices?.[0]?.finish_reason
            if (typeof reason === 'string' && reason !== '') finish = reason
          }
        }
        if (usage !== undefined) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: usage.prompt_tokens_details?.cached_tokens !== undefined
                ? usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens
                : usage.prompt_tokens ?? 0,
              outputTokens: usage.completion_tokens ?? 0,
              reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
              cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
              totalTokens: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
            },
          }
        }
        yield {
          type: 'finish',
          reason: finish === 'tool_calls' ? { kind: 'tool-calls' } : finish === 'length' ? { kind: 'max-tokens' } : { kind: 'stop' },
        }
      } catch (error) {
        if (options.signal?.aborted === true) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } } }
          return
        }
        const message = error?.cause?.code === 'ECONNREFUSED'
          ? 'the hub daemon is not running and could not be started — install it once with `npm i -g github:lfapex/free-model-hub`, or start it manually (`free-model-hub`)'
          : String(error?.message ?? error)
        yield { type: 'finish', reason: { kind: 'error', failure: { message: `free-model-hub: ${message}`, code: 'TRANSPORT' } } }
      } finally {
        options.signal?.removeEventListener('abort', onAbort)
      }
    },
  }

  /** Pull the hub's roster at boot (after any daemon start), then keep it fresh. */
  async function refreshRoster() {
    try {
      await ensureDaemon(logger, settings)
      const response = await fetch(`${settings.baseUrl}/hub-models`, {
        headers: hubHeaders(settings),
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      state.roster = payload.models ?? []
      state.byId = new Map(state.roster.map(entry => [entry.id, entry]))
      logger.info?.(`freehub2dsh: roster refreshed (${state.roster.length} models)`)
    } catch (error) {
      logger.warn?.(`freehub2dsh: roster refresh failed (${error?.message ?? error}); the picker keeps the last roster`)
    }
  }

  void refreshRoster()
  const timer = setInterval(() => { void refreshRoster() }, REFRESH_MS)
  timer.unref?.()
  ctx.on?.('dispose', () => clearInterval(timer))

  const registration = ctx.llm.registerAdapter(['freehub2dsh'], adapter)
  ctx.llm.registerConfigurableProviders?.([
    { provider: 'freehub2dsh', displayName: 'Free Model Hub', settingsNs: name, settingsPath: [] },
  ])
  ctx.llm.registerModelDiscovery?.(name, async () => {
    await refreshRoster()
    return state.roster.map(entry => ({
      id: entry.id,
      name: entry.name,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxOutput,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
    }))
  })
  ctx.on?.('loader/volatile-update', () => registration.replace(state.roster.length > 0 ? ['freehub2dsh'] : []))
}

// ── endpoint resolution + daemon autostart ──────────────────────────────────

/**
 * Endpoint settings, in priority order: dsh plugin settings →
 * `<DSH_HOME>/freehub2dsh/endpoint.json` → the hub data directory's own
 * server key with the default base URL (the zero-configuration path).
 *
 * `keyFromFile` is true when the key was (or will be) read from the hub
 * data dir, so autostart can re-hydrate it after first boot mints one.
 */
export function resolveEndpoint(config) {
  const fromConfig = {
    baseUrl: config?.hubBaseUrl,
    key: config?.hubKey,
  }
  if (typeof fromConfig.baseUrl === 'string' && fromConfig.baseUrl !== '' && typeof fromConfig.key === 'string' && fromConfig.key !== '') {
    return { baseUrl: fromConfig.baseUrl.replace(/\/+$/, ''), key: fromConfig.key, keyFromFile: false }
  }
  try {
    const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.dsh')
    const file = path.join(home, 'freehub2dsh', 'endpoint.json')
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (typeof parsed?.baseUrl === 'string' && typeof parsed?.key === 'string' && parsed.key !== '') {
        return { baseUrl: parsed.baseUrl.replace(/\/+$/, ''), key: parsed.key, keyFromFile: false }
      }
    }
  } catch { /* fall through to the zero-config path */ }
  return {
    baseUrl: typeof fromConfig.baseUrl === 'string' && fromConfig.baseUrl !== '' ? fromConfig.baseUrl.replace(/\/+$/, '') : DEFAULT_BASE,
    key: readHubKey(HUB_SETTINGS),
    keyFromFile: true,
  }
}

export function isLocalHub(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  } catch {
    return true
  }
}

/** Read-only peek at the hub's own settings file; absence means no key yet. */
export function readHubKey(file = HUB_SETTINGS) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const key = parsed?.server?.key
    return typeof key === 'string' ? key : ''
  } catch {
    return ''
  }
}

function hydrateKey(settings) {
  if (settings.keyFromFile !== true) return
  const fresh = readHubKey(HUB_SETTINGS)
  if (fresh !== '') settings.key = fresh
}

let daemonStarting = false

/**
 * Make sure a local daemon is reachable, starting one from PATH when it is
 * not. Remote hubs are left alone. After spawn the key is re-read from the
 * hub data dir — first boot mints it, and a previous empty read must not
 * stick. The spawned process is detached and outlives dsh on purpose.
 */
export async function ensureDaemon(logger, settings) {
  if (settings.keyFromFile !== true) return
  if (!isLocalHub(settings.baseUrl)) return
  hydrateKey(settings)
  if (await hubAlive(settings)) return
  if (daemonStarting) {
    for (let waited = 0; waited < START_TIMEOUT_MS; waited += 500) {
      await sleep(500)
      hydrateKey(settings)
      if (await hubAlive(settings)) return
    }
    throw new Error('the hub daemon did not come up in time')
  }
  daemonStarting = true
  let child
  try {
    child = spawn('free-model-hub', {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
      windowsHide: true,
      env: process.env,
    })
  } catch (error) {
    daemonStarting = false
    throw new Error(`could not spawn the hub daemon: ${error?.message ?? error}`)
  }
  child.on('error', () => { daemonStarting = false })
  child.unref?.()
  logger.info?.('freehub2dsh: hub daemon not running — starting it from PATH (detached)')
  try {
    for (let waited = 0; waited < START_TIMEOUT_MS; waited += 500) {
      await sleep(500)
      hydrateKey(settings)
      if (await hubAlive(settings)) {
        logger.info?.('freehub2dsh: hub daemon is up')
        return
      }
    }
    throw new Error('the hub daemon was started but never answered — is `free-model-hub` installed (`npm i -g github:lfapex/free-model-hub`)?')
  } finally {
    daemonStarting = false
  }
}

async function hubAlive(settings) {
  return settings.key !== '' && await probe(settings)
}

async function probe(settings) {
  try {
    const response = await fetch(`${settings.baseUrl}/hub-models`, {
      headers: hubHeaders(settings),
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch {
    return false
  }
}

function hubHeaders(settings) {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(settings.key !== '' ? { authorization: `Bearer ${settings.key}` } : {}),
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** dsh messages → OpenAI messages. */
function toWireMessages(messages) {
  const out = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message.role === 'developer' ? 'developer' : message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : message.role === 'tool' ? 'tool' : 'user'
    const content = []
    const toolCalls = []
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') content.push({ type: 'text', text: block.text })
      else if (block?.type === 'image') {
        const url = typeof block.attachment?.url === 'string' ? block.attachment.url : undefined
        if (url !== undefined) content.push({ type: 'image_url', image_url: { url } })
      } else if (block?.type === 'tool-call') {
        toolCalls.push({ id: block.id ?? '', type: 'function', function: { name: block.name ?? '', arguments: block.arguments ?? '{}' } })
      } else if (block?.type === 'tool-result' && typeof block.text === 'string') {
        out.push({ role: 'tool', tool_call_id: block.toolCallId ?? block.callId ?? '', content: block.text })
      }
    }
    if (role === 'tool') {
      const text = Array.isArray(message.content)
        ? message.content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
        : String(message.content ?? '')
      out.push({ role: 'tool', tool_call_id: message.toolCallId ?? message.source?.callId ?? '', content: text })
      continue
    }
    if (toolCalls.length > 0) {
      out.push({ role: 'assistant', ...(content.length ? { content } : { content: null }), tool_calls: toolCalls })
      continue
    }
    if (content.length === 0 && role === 'assistant') continue
    out.push(role === 'assistant' && content.length === 0
      ? { role, content: '' }
      : { role, content: content.length === 1 && content[0].type === 'text' ? content[0].text : content.length > 0 ? content : '' })
  }
  return out
}

/** dsh tool defs → OpenAI tool defs (flat → wrapped). */
function toWireTools(tools) {
  return tools.map(tool => {
    if (tool?.function !== undefined) return tool
    return {
      type: 'function',
      function: {
        name: String(tool?.name ?? ''),
        description: String(tool?.description ?? ''),
        parameters: tool?.parameters ?? { type: 'object', properties: {} },
      },
    }
  }).filter(tool => tool.function.name !== '')
}

export const PKG_DIR = fileURLToPath(new URL('./', import.meta.url))
