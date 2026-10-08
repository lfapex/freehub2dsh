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

/**
 * Picker group titles — a faithful copy of what dsh-our-free-model shows:
 * its `ROUTE_LABELS` (the free lane, main + region), the Kilo heading, and
 * every channel-pack `product.displayName`. DSH groups the picker strictly by
 * provider route, so each platform is its own registered provider and this
 * key order is the group order the picker shows.
 *
 * Hub-only lanes (Kilo / AtomCode / Relay / Virtual) carry headings the
 * reference plugin never shows. The anonymous free lane is labeled "OpenCode"
 * to match user expectations. `gemini` keeps its reference heading although 
 * the hub serves neither today, so that group stays empty until the hub emits them.
 * `freehub` is the catch-all for a channel provider this table grows stale on.
 */
export const PLATFORM_LABELS = {
  'opencode': 'OpenCode',
  'opencode-region': 'OpenCode · region-limited',
  kilo: 'Kilo',
  atomcode: 'AtomCode',
  codearts: 'CodeArts Agent',
  buddy: 'CodeBuddy (腾讯)',
  workbuddy: 'WorkBuddy (国际版)',
  lobsterai: 'LobsterAI (有道)',
  qoder: 'Qoder',
  qodercn: 'Qoder (中国版)',
  trae: 'TRAE (字节)',
  cline: 'Cline',
  loomy: 'Loomy (讯飞)',
  raccoon: 'Raccoon (商汤)',
  minimax: 'MiniMax Code',
  zcode: 'ZCode (智谱)',
  gemini: 'Gemini Code Assist',
  relay: 'Relay',
  virtual: 'Virtual',
  hub: 'Free Model Hub',
}

/**
 * Provider-route prefix for every route this plugin registers.
 *
 * dsh-llm keeps one flat namespace per profile: `registerAdapter` and
 * `registerConfigurableProviders` both refuse a route already declared by any
 * plugin. dsh-our-free-model's channel-pack claims the bare channel names
 * (`codearts`, `buddy`, `minimax`, `qoder`, `trae`, `cline`, `zcode`, ...)
 * plus the two free-lane routes, so this plugin uses `free-` prefix to avoid
 * conflicts while maintaining clear naming: `free-codearts`, `free-buddy`, etc.
 * 
 * This allows freehub2dsh and dsh-our-free-model to coexist, giving users
 * choice between the hub backend and the direct channel integration.
 */
const ROUTE_PREFIX = 'free-'

/** Bare platform key → the provider route actually registered. */
function routeOf(platform) {
  return platform === '' ? ROUTE_PREFIX + 'hub' : ROUTE_PREFIX + platform
}

/** Registered provider route → bare platform key. Inverse of {@link routeOf}. */
function platformOfRoute(route) {
  const bare = typeof route === 'string' && route.startsWith(ROUTE_PREFIX) ? route.slice(ROUTE_PREFIX.length) : ''
  return PLATFORM_LABELS[bare] !== undefined ? bare : 'hub'
}

/**
 * All provider routes this plugin will register.
 * Each platform gets its own route (e.g., free-codearts, free-buddy, etc.)
 * so dsh's model picker shows them as independent groups.
 */
const PLATFORM_IDS = Object.keys(PLATFORM_LABELS).map(routeOf)

/**
 * Which picker group a hub roster row belongs to.
 *
 * Uses the same precedence as freehub2copilot to ensure consistent grouping:
 * 1. Special lanes: kilo, atomcode, virtual, relay (via owned_by or channel)
 * 2. Channel providers: codearts, buddy, trae, etc. (via owned_by="chan:xxx" or ID prefix)
 * 3. Free lane: anonymous free models (owned_by="free-lane") → grouped as "OpenCode"
 * 4. Region-blocked models: separate group for region-gated models
 *
 * The hub's /v1/models endpoint returns OpenAI-compatible format with owned_by,
 * channel, provider fields that enable accurate platform detection.
 */
export function platformOf(entry) {
  const id = textOf(entry?.id)
  const channel = textOf(entry?.channel)
  const provider = textOf(entry?.provider)
  const owned = textOf(entry?.owned_by || entry?.ownedBy)
  const state = textOf(entry?.state)
  
  // Kilo: owned_by="kilo" or channel="kilo" or id contains ":free"
  if (channel === 'kilo' || owned === 'kilo' || (id.includes(':free') && !id.startsWith('codearts/'))) {
    return 'kilo'
  }
  
  // AtomCode: owned_by="atomcode" or channel="atomcode" or id starts with "atomcode/"
  if (channel === 'atomcode' || owned === 'atomcode' || id.startsWith('atomcode/')) {
    return 'atomcode'
  }
  
  // Virtual: owned_by="virtual" or channel="virtual"
  if (channel === 'virtual' || owned === 'virtual') {
    return 'virtual'
  }
  
  // Relay: owned_by starts with "relay:"
  if (owned.startsWith('relay:')) {
    return 'relay'
  }
  
  // Channel providers: owned_by="chan:xxx" or channel="chan"
  // Extract the provider name from owned_by or use provider/ID prefix
  if (owned.startsWith('chan:')) {
    const chanProvider = owned.slice(5) // Remove "chan:" prefix
    return PLATFORM_LABELS[chanProvider] !== undefined ? chanProvider : 'hub'
  }
  
  if (channel === 'chan') {
    const chanProvider = provider || idHead(id)
    return PLATFORM_LABELS[chanProvider] !== undefined ? chanProvider : 'hub'
  }
  
  // Check ID prefix for channel providers (fallback)
  const head = idHead(id)
  if (PLATFORM_LABELS[head] !== undefined && head !== 'opencode' && head !== 'opencode-region') {
    return head
  }
  
  // Region-blocked models: separate group
  if (state === 'region-blocked' || state === 'regionBlocked') {
    return 'opencode-region'
  }
  
  // Default: anonymous free lane (owned_by="free-lane" or no special markers) → OpenCode
  return 'opencode'
}

function idHead(id) {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : ''
}

/** Bare model id the picker shows: routing prefixes belong to the group heading. */
export function pickerIdOf(entry) {
  const id = textOf(entry?.id)
  if (id === '') return ''
  const platform = platformOf(entry)
  
  // 去除各个平台的 ID 前缀
  if (platform === 'codearts' && id.startsWith('codearts/')) return id.slice('codearts/'.length)
  if (platform === 'atomcode' && id.startsWith('atomcode/')) return id.slice('atomcode/'.length)
  if (platform === 'opencode' && id.startsWith('opencode/')) return id.slice('opencode/'.length)
  if (platform === 'gemini') {
    if (id.startsWith('google/gemini/')) return id.slice('google/gemini/'.length)
    if (id.startsWith('gemini/')) return id.slice('gemini/'.length)
  }
  if (platform === 'buddy' && id.startsWith('buddy/')) return id.slice('buddy/'.length)
  if (platform === 'workbuddy' && id.startsWith('workbuddy/')) return id.slice('workbuddy/'.length)
  if (platform === 'lobsterai' && id.startsWith('lobsterai/')) return id.slice('lobsterai/'.length)
  if (platform === 'qoder' && id.startsWith('qoder/')) return id.slice('qoder/'.length)
  if (platform === 'qodercn' && id.startsWith('qodercn/')) return id.slice('qodercn/'.length)
  if (platform === 'trae' && id.startsWith('trae/')) return id.slice('trae/'.length)
  if (platform === 'cline' && id.startsWith('cline/')) return id.slice('cline/'.length)
  if (platform === 'loomy' && id.startsWith('loomy/')) return id.slice('loomy/'.length)
  if (platform === 'raccoon' && id.startsWith('raccoon/')) return id.slice('raccoon/'.length)
  if (platform === 'minimax' && id.startsWith('minimax/')) return id.slice('minimax/'.length)
  if (platform === 'zcode' && id.startsWith('zcode/')) return id.slice('zcode/'.length)
  if (platform === 'kilo' && id.startsWith('kilo/')) return id.slice('kilo/'.length)
  
  return id
}

/** Friendly picker name: never the `provider/model` wire id, never a raw slug. */
export function displayNameOf(entry) {
  const id = textOf(entry?.id)
  const given = textOf(entry?.name)
  if (given !== '' && isPrettyName(given, id)) return given
  const bare = bareId(id)
  if (platformOf(entry) === 'kilo') return `Kilo ${titleCase(bare.replace(/:free$/i, ''))}`
  return titleCase(bare.replace(/-free$/i, ''))
}

/**
 * Hub `/v1/models` rows → the shell's internal roster, one row per
 * (platform, picker id). The `/v1/models` endpoint returns OpenAI-compatible
 * format with `owned_by`, `channel`, `provider` fields that enable accurate
 * platform detection, unlike `/hub-models` which only has basic fields.
 */
export function buildRoster(rows) {
  const roster = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    const hubId = textOf(row.id)
    if (hubId === '') continue
    const platform = platformOf(row)
    const pickerId = pickerIdOf(row) || hubId
    const key = `${platform}\0${pickerId}`
    if (seen.has(key)) continue
    seen.add(key)
    roster.push({
      hubId,
      pickerId,
      platform,
      name: displayNameOf(row),
      contextWindow: positiveInt(row.context_window || row.contextWindow) ?? 131072,
      maxOutput: positiveInt(row.max_output || row.maxOutput) ?? 32768,
      vision: row.vision === true,
      efforts: Array.isArray(row.efforts) ? row.efforts.filter(item => typeof item === 'string' ? item !== '' : typeof item?.id === 'string' && item.id !== '') : [],
      effortDefault: typeof row.effortDefault === 'string' ? row.effortDefault : typeof row.effort_default === 'string' ? row.effort_default : undefined,
    })
  }
  return roster
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function bareId(id) {
  const slash = id.lastIndexOf('/')
  return slash >= 0 ? id.slice(slash + 1) : id
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** True when `name` is already a picker label, not a routing id or a slug. */
function isPrettyName(name, id) {
  if (name === '' || name === id) return false
  if (name.includes('/')) return false
  if (/^[a-z0-9]+(?:[-_.:][a-z0-9]+)+$/.test(name)) return false
  return true
}

function titleCase(raw) {
  // 保留短划线，只处理下划线、冒号和点号
  // 这样 deepseek-v4 保持为 Deepseek-V4，而不是 Deepseek V4
  return raw
    .replace(/[_.:]+/g, '-')
    .trim()
    .split('-')
    .filter(word => word !== '')
    .map(word => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('-')
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console

  if (config?.hubEnabled === false) {
    logger.info?.('freehub2dsh: disabled in its dsh settings; nothing registered')
    return
  }

  const settings = resolveEndpoint(config)
  const state = {
    /** @type {Array<{hubId: string, pickerId: string, platform: string, name: string, contextWindow: number, maxOutput: number, vision: boolean, efforts?: string[]}>} */
    roster: [],
    /** pickerKey (`platform\\0pickerId`) or hubId → roster row */
    byId: new Map(),
  }

  /**
   * Find a roster row by whatever the dsh side is holding.
   *
   * `provider` arrives as the registered route (`freehub-<platform>`) from
   * providerInfo / listModels / resolveModel / prepareCall, and `model` is the
   * picker id or — when a caller round-trips the hub-side id — the wire id
   * itself. Index keys stay in bare platform space, so translate the route
   * first and keep the bare-id short-circuit last.
   */
  function lookup(provider, model) {
    const platform = platformOfRoute(provider)
    return state.byId.get(`${platform}\0${model}`) ?? state.byId.get(model)
  }

  function hubIdOf(provider, model) {
    return lookup(provider, model)?.hubId ?? model
  }

  const adapter = {
    providerInfo(provider) {
      const platform = platformOfRoute(provider)
      return { id: routeOf(platform), name: PLATFORM_LABELS[platform] }
    },

    // dsh-llm prepareRoutes calls this at register time; a missing method is TypeError and the plugin never activates.
    providerRetryPolicy: () => undefined,

    imageRequestPricing: () => undefined,

    async listModels(provider) {
      const platform = platformOfRoute(provider)
      return state.roster.filter(entry => entry.platform === platform).map(entry => ({
        provider: routeOf(platform),
        id: entry.pickerId,
        name: entry.name,
        description: `${entry.vision ? 'vision + text' : 'text'} · ${Math.round(entry.contextWindow / 1024)}K context`,
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      }))
    },

    async resolveModel(provider, model) {
      const entry = lookup(provider, model)
      const route = routeOf(platformOfRoute(provider))
      if (entry === undefined) {
        return { provider: route, id: model, name: model, context: { contextWindow: 131072 }, defaultMaxTokens: 8192 }
      }
      const contextWindow = Number.isInteger(entry.contextWindow) && entry.contextWindow > 0 ? entry.contextWindow : 131072
      const defaultMaxTokens = Number.isSafeInteger(entry.maxOutput) && entry.maxOutput > 0 ? Math.min(entry.maxOutput, 32768) : 8192
      return {
        provider: route,
        id: entry.pickerId,
        name: entry.name,
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
        context: { contextWindow },
        defaultMaxTokens,
        ...reasoningOf(entry),
      }
    },

    async prepareCall(provider, model) {
      const resolved = await this.resolveModel(provider, model)
      const hubId = hubIdOf(provider, model)
      return { model: resolved, stream: options => this.stream({ ...options, model: hubId }) }
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
        const sink = createBlockSink()
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
              if (typeof delta.content === 'string' && delta.content !== '') yield* sink.text(delta.content)
              if (typeof delta.reasoning === 'string' && delta.reasoning !== '') yield* sink.reasoning(delta.reasoning)
              if (Array.isArray(delta.tool_calls)) {
                for (const call of delta.tool_calls) yield* sink.toolCall(call)
              }
            }
            if (event.usage !== undefined) usage = event.usage
            const reason = event.choices?.[0]?.finish_reason
            if (typeof reason === 'string' && reason !== '') finish = reason
          }
        }
        yield* sink.close()
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

  const registration = ctx.llm.registerAdapter(PLATFORM_IDS, adapter)
  ctx.llm.registerConfigurableProviders?.(PLATFORM_IDS.map(route => ({
    provider: route,
    displayName: PLATFORM_LABELS[platformOfRoute(route)],
    settingsNs: name,
    settingsPath: [],
  })))

  /** Pull the hub's roster at boot (after any daemon start), then keep it fresh. */
  async function refreshRoster() {
    try {
      await ensureDaemon(logger, settings)
      // Use /v1/models endpoint (OpenAI-compatible format) instead of /hub-models
      // because it includes owned_by, channel, provider fields needed for accurate
      // platform detection, matching freehub2copilot's approach.
      const response = await fetch(`${settings.baseUrl}/v1/models`, {
        headers: hubHeaders(settings),
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      state.roster = buildRoster(payload.data ?? [])
      state.byId = new Map(state.roster.flatMap(entry => [[`${entry.platform}\0${entry.pickerId}`, entry], [entry.hubId, entry]]))
      logger.info?.(`freehub2dsh: roster refreshed (${state.roster.length} models across ${new Set(state.roster.map(entry => entry.platform)).size} platforms)`)
      try { registration.replace(PLATFORM_IDS) } catch { /* fiber already disposed */ }
    } catch (error) {
      logger.warn?.(`freehub2dsh: roster refresh failed (${error?.message ?? error}); the picker keeps the last roster`)
    }
  }

  ctx.llm.registerModelDiscovery?.(name, async () => {
    await refreshRoster()
    return state.roster.map(entry => ({
      id: entry.pickerId,
      name: entry.name,
      platform: entry.platform,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxOutput,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
    }))
  })

  void refreshRoster()
  const timer = setInterval(() => { void refreshRoster() }, REFRESH_MS)
  timer.unref?.()
  ctx.on?.('dispose', () => clearInterval(timer))
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

/** Hub roster stores effort ids as strings; dsh-llm requires `{ id, name }` objects. */
export function reasoningOf(entry) {
  const raw = Array.isArray(entry?.efforts) ? entry.efforts : []
  const seen = new Set()
  const efforts = []
  for (const item of raw) {
    const id = typeof item === 'string' ? item : typeof item?.id === 'string' ? item.id : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const name = typeof item === 'object' && typeof item?.name === 'string' && item.name !== '' ? item.name : effortLabel(id)
    efforts.push({
      id,
      name,
      ...(typeof item === 'object' && typeof item?.description === 'string' && item.description !== '' ? { description: item.description } : {}),
    })
  }
  if (efforts.length === 0) return {}
  const preferred = typeof entry.effortDefault === 'string' ? entry.effortDefault
    : typeof entry.effort_default === 'string' ? entry.effort_default
    : undefined
  const defaultEffort = preferred !== undefined && seen.has(preferred) ? preferred : efforts[efforts.length - 1].id
  return { reasoning: { efforts, defaultEffort } }
}

function effortLabel(id) {
  switch (id) {
    case 'none': return 'Off'
    case 'disabled': return 'Off'
    case 'light': return 'Light'
    case 'low': return 'Low'
    case 'balanced': return 'Balanced'
    case 'medium': return 'Medium'
    case 'high': return 'High'
    case 'deep': return 'Deep'
    case 'xhigh': return 'Extra high'
    case 'max': return 'Max'
    default: return id
  }
}

/** dsh-llm invariant: every delta addresses an open block (start → delta → end). */
function createBlockSink() {
  const open = new Map()
  let next = 0
  let textIndex
  let reasoningIndex
  const tools = new Map()

  function start(blockType) {
    const index = next++
    open.set(index, { type: blockType, text: '', id: '', name: '', args: '' })
    return index
  }

  return {
    * text(delta) {
      if (textIndex === undefined) {
        textIndex = start('text')
        yield { type: 'block-start', index: textIndex, blockType: 'text' }
      }
      open.get(textIndex).text += delta
      yield { type: 'text-delta', index: textIndex, text: delta }
    },
    * reasoning(delta) {
      if (reasoningIndex === undefined) {
        reasoningIndex = start('reasoning')
        yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' }
      }
      open.get(reasoningIndex).text += delta
      yield { type: 'reasoning-delta', index: reasoningIndex, text: delta }
    },
    * toolCall(call) {
      const wire = call.index ?? 0
      let index = tools.get(wire)
      if (index === undefined) {
        index = start('tool-call')
        tools.set(wire, index)
        yield { type: 'block-start', index, blockType: 'tool-call' }
      }
      const partial = open.get(index)
      if (typeof call.id === 'string' && call.id !== '') partial.id = call.id
      if (typeof call.function?.name === 'string' && call.function.name !== '') partial.name = call.function.name
      const args = typeof call.function?.arguments === 'string' ? call.function.arguments : ''
      if (args !== '') partial.args += args
      yield {
        type: 'tool-call-delta',
        index,
        id: partial.id,
        ...(partial.name !== '' ? { name: partial.name } : {}),
        argumentsDelta: args,
      }
    },
    * close() {
      for (const [index, partial] of open) {
        const block = partial.type === 'text' ? { type: 'text', text: partial.text }
          : partial.type === 'reasoning' ? { type: 'reasoning', text: partial.text }
          : { type: 'tool-call', id: partial.id, name: partial.name, arguments: partial.args }
        yield { type: 'block-end', index, block }
      }
      open.clear()
    },
  }
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
