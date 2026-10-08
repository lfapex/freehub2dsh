#!/usr/bin/env node
/**
 * Smoke test for the dsh shell's pure logic under plain Node: endpoint
 * resolution (three-tier priority), key-file degradation, and the SSE → dsh
 * chunk re-emission with a mock hub listener, and the roster → per-platform
 * picker registration the picker grouping is built on.
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const mod = await import('../index.js')

async function readJson(req) {
  let raw = ''
  for await (const piece of req) raw += piece
  return raw === '' ? undefined : JSON.parse(raw)
}

function post(port, urlPath, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

test('SSE stream from a mock hub re-emits as dsh chunks with usage and finish', async () => {
  const SSE = (delta, extra = {}) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`
  const server = http.createServer((req, res) => {
    if (req.url === '/hub-models') {
      assert.equal(req.headers.authorization, 'Bearer K-mock')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: [{ id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash', contextWindow: 128000, maxOutput: 64000, vision: false }], at: 1 }))
      return
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(SSE({ role: 'assistant', content: '' }))
      res.write(SSE({ content: 'MOCK' }))
      res.write(SSE({ reasoning: 'thinking…' }))
      res.write(SSE({}, { usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } }))
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(18740, '127.0.0.1', resolve))

  // Drive the adapter's stream directly through a fake plugin context.
  const originalFetch = globalThis.fetch
  let registered
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    llm: {
      registerAdapter: (providers, adapter) => {
        // Mirror dsh-llm prepareRoutes: a missing providerRetryPolicy is TypeError at activate.
        const policy = adapter.providerRetryPolicy(providers[0])
        assert.equal(policy, undefined)
        registered = adapter
        return { replace() {} }
      },
    },
    on: () => {},
  }
  const config = { hubBaseUrl: 'http://127.0.0.1:18740', hubKey: 'K-mock' }
  mod.apply(ctx, config)
  assert.ok(registered, 'adapter registered')

  const chunks = []
  for await (const chunk of registered.stream({ model: 'deepseek-v4-flash-free', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], sessionId: 'smoke' })) {
    chunks.push(chunk)
  }
  const text = chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('')
  assert.equal(text, 'MOCK')
  const textStart = chunks.find(c => c.type === 'block-start' && c.blockType === 'text')
  assert.equal(typeof textStart?.index, 'number')
  const textDelta = chunks.find(c => c.type === 'text-delta')
  assert.equal(textDelta.index, textStart.index)
  const reasoning = chunks.find(c => c.type === 'reasoning-delta')
  assert.equal(reasoning?.text, 'thinking…')
  assert.equal(typeof reasoning.index, 'number')
  assert.ok(chunks.some(c => c.type === 'block-end' && c.block?.type === 'text'))
  assert.ok(chunks.some(c => c.type === 'block-end' && c.block?.type === 'reasoning'))
  const usage = chunks.find(c => c.type === 'usage')
  assert.equal(usage.usage.totalTokens, 11)
  assert.equal(usage.usage.cacheReadTokens, 0)
  const finish = chunks.find(c => c.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'stop' })
  const finishAt = chunks.findIndex(c => c.type === 'finish')
  assert.ok(chunks.findIndex(c => c.type === 'block-end') < finishAt)

  globalThis.fetch = originalFetch
  server.close()
})

test('a turn against a dead hub yields the install hint, not a raw stack', async () => {
  const originalFetch = globalThis.fetch
  let registered
  const ctx = { logger: { info: () => {}, warn: () => {} }, llm: { registerAdapter: (p, a) => { a.providerRetryPolicy(p[0]); registered = a; return { replace() {} } } }, on: () => {} }
  // A port nothing listens on; an explicit key so no daemon autostart fires.
  mod.apply(ctx, { hubBaseUrl: 'http://127.0.0.1:18741', hubKey: 'K-x' })
  const chunks = []
  for await (const chunk of registered.stream({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
    chunks.push(chunk)
  }
  const finish = chunks.find(c => c.type === 'finish')
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /free-model-hub/)
  assert.ok(!/at \w+ \(/.test(finish.reason.failure.message), 'no stack frames leak into the message')
  globalThis.fetch = originalFetch
})

test('endpoint resolution: explicit config wins and skips file-key hydration', () => {
  const settings = mod.resolveEndpoint({ hubBaseUrl: 'http://10.0.0.8:8330', hubKey: 'K-remote' })
  assert.equal(settings.baseUrl, 'http://10.0.0.8:8330')
  assert.equal(settings.key, 'K-remote')
  assert.equal(settings.keyFromFile, false)
  assert.equal(mod.isLocalHub(settings.baseUrl), false)
})

test('hub string efforts become dsh {id,name} objects without duplicates', () => {
  const fromStrings = mod.reasoningOf({ efforts: ['high', 'max', 'low', 'high'], effortDefault: 'max' })
  assert.deepEqual(fromStrings.reasoning.efforts.map(e => e.id), ['high', 'max', 'low'])
  assert.equal(fromStrings.reasoning.efforts[0].name, 'High')
  assert.equal(fromStrings.reasoning.defaultEffort, 'max')
  const fromObjects = mod.reasoningOf({ efforts: [{ id: 'high', name: 'High' }, { id: 'high', name: 'dup' }] })
  assert.equal(fromObjects.reasoning.efforts.length, 1)
  assert.equal(fromObjects.reasoning.defaultEffort, 'high')
  assert.deepEqual(mod.reasoningOf({ efforts: [] }), {})
  assert.deepEqual(mod.reasoningOf({}), {})
})

test('PLATFORM_LABELS mirrors dsh-our-free-model per platform', () => {
  const L = mod.PLATFORM_LABELS
  // Keys are the hub-side lane tags; the registered provider routes carry a
  // freehub- prefix (see routeOf) so the bare channel names stay reserved for
  // dsh-our-free-model's channel-pack.
  assert.equal(L['our-free-model'], 'Our Free Model')
  assert.equal(L['our-free-model-region'], 'Our Free Model · region-limited')
  assert.equal(L.kilo, 'Kilo')
  assert.equal(L.atomcode, 'AtomCode')
  assert.equal(L.codearts, 'CodeArts Agent')
  assert.equal(L.buddy, 'CodeBuddy (腾讯)')
  assert.equal(L.workbuddy, 'WorkBuddy (国际版)')
  assert.equal(L.lobsterai, 'LobsterAI (有道)')
  assert.equal(L.qoder, 'Qoder')
  assert.equal(L.qodercn, 'Qoder (中国版)')
  assert.equal(L.trae, 'TRAE (字节)')
  assert.equal(L.cline, 'Cline')
  assert.equal(L.loomy, 'Loomy (讯飞)')
  assert.equal(L.raccoon, 'Raccoon (商汤)')
  assert.equal(L.minimax, 'MiniMax Code')
  assert.equal(L.zcode, 'ZCode (智谱)')
  assert.equal(L.opencode, 'OpenCode')
  assert.equal(L.gemini, 'Gemini Code Assist')
  assert.equal(L.relay, 'Relay')
  assert.equal(L.virtual, 'Virtual')
  assert.equal(L.freehub, 'Free Model Hub')
})

test('platformOf groups a roster row the way dsh-our-free-model does', () => {
  // Lane tags outrank id shape, and a region-*sensitive* row that still routes
  // stays in the main group — only a region-blocked verdict moves it.
  assert.equal(mod.platformOf({ id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash', channel: 'free', owned_by: 'our-free-model', state: 'available' }), 'our-free-model')
  assert.equal(mod.platformOf({ id: 'muse-spark-1.3-contributor-free', channel: 'free', regionSensitive: true, state: 'available', owned_by: 'our-free-model' }), 'our-free-model')
  assert.equal(mod.platformOf({ id: 'muse-spark-1.2-contributor-free', channel: 'free', regionSensitive: true, state: 'region-blocked', owned_by: 'our-free-model-region' }), 'our-free-model-region')
  assert.equal(mod.platformOf({ id: 'nvidia/nemotron-3.5-lightning:free', name: 'Kilo Nemotron 3.5 Lightning', channel: 'kilo', owned_by: 'kilo' }), 'kilo')
  assert.equal(mod.platformOf({ id: 'nvidia/nemotron-3.5-lightning:free', owned_by: 'kilo' }), 'kilo')
  assert.equal(mod.platformOf({ id: 'buddy/deepseek-v4-pro', channel: 'chan', provider: 'buddy', owned_by: 'chan:buddy' }), 'buddy')
  assert.equal(mod.platformOf({ id: 'trae/kimi-k3', owned_by: 'chan:trae' }), 'trae')
  assert.equal(mod.platformOf({ id: 'zcode/GLM-5.3', channel: 'chan', provider: 'zcode' }), 'zcode')
  assert.equal(mod.platformOf({ id: 'newchan/gpt-x', channel: 'chan', provider: 'newchan', owned_by: 'chan:newchan' }), 'freehub')
  assert.equal(mod.platformOf({ id: 'atomcode/GLM-5.2', channel: 'atomcode', owned_by: 'atomcode' }), 'atomcode')
  assert.equal(mod.platformOf({ id: 'gpt-4o', channel: 'relay', owned_by: 'relay:home' }), 'relay')
  assert.equal(mod.platformOf({ id: 'my-alias', channel: 'virtual', owned_by: 'virtual' }), 'virtual')
  assert.equal(mod.platformOf({ id: 'whatever-new-lane/x', channel: 'future' }), 'our-free-model')
})

test('pickerIdOf and displayNameOf never leak a routing prefix or a slug', () => {
  assert.equal(mod.pickerIdOf({ id: 'buddy/deepseek-v4-pro', channel: 'chan', provider: 'buddy' }), 'deepseek-v4-pro')
  assert.equal(mod.pickerIdOf({ id: 'atomcode/GLM-5.2', channel: 'atomcode' }), 'GLM-5.2')
  assert.equal(mod.pickerIdOf({ id: 'nvidia/nemotron-3.5-lightning:free', channel: 'kilo' }), 'nvidia/nemotron-3.5-lightning:free')
  assert.equal(mod.pickerIdOf({ id: 'mimo-v2.6-flash-free', channel: 'free' }), 'mimo-v2.6-flash-free')
  assert.equal(mod.pickerIdOf({ id: 'gpt-4o', channel: 'relay' }), 'gpt-4o')

  assert.equal(mod.displayNameOf({ id: 'buddy/deepseek-v4-pro', name: 'DeepSeek V4 Pro', channel: 'chan', provider: 'buddy' }), 'DeepSeek V4 Pro')
  assert.equal(mod.displayNameOf({ id: 'trae/kimi-k3', name: 'kimi-k3', channel: 'chan', provider: 'trae' }), 'Kimi K3')
  assert.equal(mod.displayNameOf({ id: 'nvidia/nemotron-3.5-lightning:free', name: 'NVIDIA: Nemotron 3.5 Lightning (free)', channel: 'kilo' }), 'NVIDIA: Nemotron 3.5 Lightning (free)')
  assert.equal(mod.displayNameOf({ id: 'nvidia/nemotron-3-ultra:free', channel: 'kilo' }), 'Kilo Nemotron 3 Ultra')
  assert.equal(mod.displayNameOf({ id: 'newchan/gpt-x', name: 'gpt-x', channel: 'chan', provider: 'newchan' }), 'Gpt X')
})

test('buildRoster maps one hub row per platform/picker id and drops junk', () => {
  const roster = mod.buildRoster([
    { id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash', channel: 'free', contextWindow: 1048576, maxOutput: 131072, vision: true, efforts: ['low', 'high', 'high'], effortDefault: 'high', state: 'available', routable: true },
    { id: 'buddy/deepseek-v4-pro', name: 'DeepSeek V4 Pro', channel: 'chan', provider: 'buddy', owned_by: 'chan:buddy', contextWindow: 128000, maxOutput: 8192, state: 'available', routable: true },
    { id: 'gpt-4o', name: 'Relay gpt-4o', channel: 'relay', owned_by: 'relay:home', state: 'available', routable: true },
    { id: 'gpt-4o', name: 'Relay gpt-4o (work)', channel: 'relay', owned_by: 'relay:work', state: 'available', routable: true },
    { id: '', name: 'no id', channel: 'free' },
    null,
    'not-a-row',
  ])
  assert.equal(roster.length, 3, 'one row per platform/picker id; idless and non-object rows dropped')

  const free = roster.find(entry => entry.platform === 'our-free-model')
  assert.deepEqual(free, {
    hubId: 'mimo-v2.6-flash-free', pickerId: 'mimo-v2.6-flash-free', platform: 'our-free-model', name: 'MiMo V2.6 Flash',
    contextWindow: 1048576, maxOutput: 131072, vision: true, efforts: ['low', 'high', 'high'], effortDefault: 'high',
  })
  assert.deepEqual(free.efforts, ['low', 'high', 'high'], 'roster keeps the hub ids verbatim; dedupe/name mapping is dsh-adapter side')

  const buddy = roster.find(entry => entry.platform === 'buddy')
  assert.equal(buddy.pickerId, 'deepseek-v4-pro')
  assert.equal(buddy.hubId, 'buddy/deepseek-v4-pro')
  assert.equal(buddy.maxOutput, 8192)

  const relay = roster.find(entry => entry.platform === 'relay')
  assert.equal(relay.hubId, 'gpt-4o')
  assert.equal(relay.name, 'Relay gpt-4o', 'first relay declaring an id wins; the hub otherwise never duplicates')
  assert.equal(relay.contextWindow, 131072, 'capability defaults when the row states none')
  assert.deepEqual(relay.efforts, [])
})

test('package.json does not declare a web client without a ./client export', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (pkg.dsh?.client !== undefined) {
    assert.ok(pkg.exports?.['./client'], 'dsh.client requires exports["./client"]; omitting it crashes DSH on boot')
  }
})

test('endpoint resolution: missing key file degrades to empty key, still local', () => {
  const missing = path.join(os.tmpdir(), 'no-such-freehub-settings.json')
  const key = mod.readHubKey(missing)
  assert.equal(key, '')
  const settings = mod.resolveEndpoint({})
  assert.equal(settings.keyFromFile, true)
  assert.equal(mod.isLocalHub(settings.baseUrl), true)
})

/** One row per lane, shaped exactly like the hub's /hub-models `pickerRows`. */
const HUB_ROSTER = [
  { id: 'mimo-v2.6-flash-free', name: 'MiMo V2.6 Flash', contextWindow: 1048576, maxOutput: 131072, vision: true, efforts: ['low', 'high'], effortDefault: 'high', channel: 'free', owned_by: 'our-free-model', state: 'available', routable: true },
  { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3', contextWindow: 1048576, maxOutput: 131072, vision: true, channel: 'free', owned_by: 'our-free-model', regionSensitive: true, state: 'available', routable: true },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2', contextWindow: 1048576, maxOutput: 131072, vision: true, channel: 'free', owned_by: 'our-free-model-region', regionSensitive: true, state: 'region-blocked', routable: true },
  { id: 'nvidia/nemotron-3.5-lightning:free', name: 'Kilo Nemotron 3.5 Lightning', channel: 'kilo', owned_by: 'kilo', efforts: ['disabled', 'low', 'medium', 'high'], effortDefault: 'high', contextWindow: 128000, maxOutput: 32768, state: 'available', routable: true },
  { id: 'buddy/deepseek-v4-pro', name: 'DeepSeek V4 Pro', channel: 'chan', provider: 'buddy', owned_by: 'chan:buddy', contextWindow: 128000, maxOutput: 8192, state: 'available', routable: true },
  { id: 'trae/kimi-k3', name: 'kimi-k3', channel: 'chan', provider: 'trae', owned_by: 'chan:trae', contextWindow: 262144, maxOutput: 16384, state: 'available', routable: true },
  { id: 'atomcode/GLM-5.2', name: 'GLM-5.2', channel: 'atomcode', owned_by: 'atomcode', contextWindow: 202752, maxOutput: 65536, state: 'available', routable: true },
  { id: 'gpt-4o', name: 'Relay gpt-4o', channel: 'relay', owned_by: 'relay:home', contextWindow: 128000, maxOutput: 16384, state: 'available', routable: true },
  { id: 'my-alias', name: 'My Alias', channel: 'virtual', owned_by: 'virtual', contextWindow: 262144, maxOutput: 65536, state: 'available', routable: true },
  { id: 'newchan/gpt-x', name: 'gpt-x', channel: 'chan', provider: 'newchan', owned_by: 'chan:newchan', state: 'available', routable: true },
]

test('hub roster registers one picker group per platform and re-binds hub wire ids per turn', async () => {
  const SSE = (delta, extra = {}) =>
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }], ...extra }) + '\n\n'
  let chatBody
  const server = http.createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method === 'GET' && path === '/hub-models') {
      assert.equal(req.headers.authorization, 'Bearer K-roster')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: HUB_ROSTER, at: 1 }))
      return
    }
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      chatBody = await readJson(req)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(SSE({ content: 'ok' }))
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(18742, '127.0.0.1', resolve))

  let rosterReady
  const ready = new Promise(resolve => { rosterReady = resolve })
  const stall = new Promise((_, reject) => { setTimeout(() => reject(new Error('roster never refreshed')), 5000) })
  let registered
  let providers
  let configurable
  const ctx = {
    logger: { info: message => { if (String(message).includes('roster refreshed')) rosterReady() }, warn: () => {} },
    llm: {
      registerAdapter(list, adapter) {
        adapter.providerRetryPolicy(list[0])
        registered = adapter
        providers = list
        return { replace() {} }
      },
      registerConfigurableProviders(rows) { configurable = rows },
      registerModelDiscovery() {},
    },
    on: () => {},
  }
  mod.apply(ctx, { hubBaseUrl: 'http://127.0.0.1:18742', hubKey: 'K-roster' })
  await Promise.race([ready, stall])

  // Every platform is its own registered provider; the array order is the
  // picker's group order. Routes carry the freehub- prefix so they cannot
  // collide with the bare channel names dsh-our-free-model's channel-pack
  // declares in the same profile.
  const bareKeys = Object.keys(mod.PLATFORM_LABELS)
  assert.deepEqual(providers, bareKeys.map(platform => `freehub-${platform}`))
  assert.equal(configurable.length, providers.length)
  assert.equal(configurable.find(row => row.provider === 'freehub-zcode').displayName, 'ZCode (智谱)')
  assert.equal(configurable.find(row => row.provider === 'freehub-our-free-model').displayName, 'Our Free Model')

  // providerInfo maps a registered route back to its bare lane tag.
  assert.deepEqual(registered.providerInfo('freehub-buddy'), { id: 'freehub-buddy', name: 'CodeBuddy (腾讯)' })
  assert.deepEqual(registered.providerInfo('freehub-our-free-model'), { id: 'freehub-our-free-model', name: 'Our Free Model' })
  assert.deepEqual(registered.providerInfo('freehub-kilo'), { id: 'freehub-kilo', name: 'Kilo' })
  assert.deepEqual(registered.providerInfo('freehub-freehub'), { id: 'freehub-freehub', name: 'Free Model Hub' })

  // Free lane: bare ids, reference display names, region split by verdict.
  const freeModels = await registered.listModels('freehub-our-free-model')
  assert.deepEqual(freeModels.map(model => model.id), ['mimo-v2.6-flash-free', 'muse-spark-1.3-contributor-free'])
  const vision = freeModels.find(model => model.id === 'mimo-v2.6-flash-free')
  assert.equal(vision.name, 'MiMo V2.6 Flash')
  assert.deepEqual(vision.inputModalities, ['text', 'image'])
  assert.match(vision.description, /vision \+ text · 1024K context/)
  const regionModels = await registered.listModels('freehub-our-free-model-region')
  assert.deepEqual(regionModels.map(model => model.id), ['muse-spark-1.2-contributor-free'])

  // Kilo keeps its hub ids; channels lose the provider/ routing prefix.
  const kiloModels = await registered.listModels('freehub-kilo')
  assert.deepEqual(kiloModels.map(model => model.id), ['nvidia/nemotron-3.5-lightning:free'])
  assert.equal(kiloModels[0].name, 'Kilo Nemotron 3.5 Lightning')
  const buddyModels = await registered.listModels('freehub-buddy')
  assert.deepEqual(buddyModels.map(model => model.id), ['deepseek-v4-pro'])
  assert.equal(buddyModels[0].name, 'DeepSeek V4 Pro')
  assert.equal(buddyModels[0].provider, 'freehub-buddy')
  assert.deepEqual((await registered.listModels('freehub-atomcode')).map(model => model.id), ['GLM-5.2'])
  assert.deepEqual((await registered.listModels('freehub-relay')).map(model => model.id), ['gpt-4o'])
  assert.deepEqual((await registered.listModels('freehub-virtual')).map(model => model.id), ['my-alias'])
  const fallback = await registered.listModels('freehub-freehub')
  assert.deepEqual(fallback.map(model => model.id), ['gpt-x'])
  assert.equal(fallback[0].name, 'Gpt X')

  // resolveModel: reference-grade facts, efforts as {id,name} objects.
  const free = await registered.resolveModel('freehub-our-free-model', 'mimo-v2.6-flash-free')
  assert.equal(free.name, 'MiMo V2.6 Flash')
  assert.equal(free.context.contextWindow, 1048576)
  assert.equal(free.defaultMaxTokens, 32768)
  assert.deepEqual(free.reasoning.efforts.map(effort => effort.id), ['low', 'high'])
  assert.equal(free.reasoning.defaultEffort, 'high')
  const kilo = await registered.resolveModel('freehub-kilo', 'nvidia/nemotron-3.5-lightning:free')
  assert.deepEqual(kilo.reasoning.efforts.map(effort => effort.id), ['disabled', 'low', 'medium', 'high'])
  assert.deepEqual(kilo.reasoning.efforts.map(effort => effort.name), ['Off', 'Low', 'Medium', 'High'])

  // A turn aimed at a picker id must reach the hub under the wire id.
  const buddyCall = await registered.prepareCall('freehub-buddy', 'deepseek-v4-pro')
  assert.equal(buddyCall.model.name, 'DeepSeek V4 Pro')
  for await (const chunk of buddyCall.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) { void chunk }
  assert.equal(chatBody.model, 'buddy/deepseek-v4-pro')

  const fallbackCall = await registered.prepareCall('freehub-freehub', 'gpt-x')
  assert.equal(fallbackCall.model.name, 'Gpt X')
  for await (const chunk of fallbackCall.stream({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) { void chunk }
  assert.equal(chatBody.model, 'newchan/gpt-x')

  server.close()
})
